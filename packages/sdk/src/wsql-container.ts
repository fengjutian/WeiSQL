/**
 * `.wsql` single-file container (V1).
 *
 * Deploying a package means shipping a dozen files with a relative layout that
 * must stay intact. The container turns that into one file: an 8-byte magic, a
 * uint32 LE header length, a JSON header with per-file offsets and digests, then
 * the file bytes back to back.
 *
 * Layout:
 *
 *   "WSQLPKG1" | uint32 LE headerBytes | header JSON | file bytes...
 *
 * The format is deliberately uncompressed and unencrypted: the same reasoning as
 * JSONL ID Maps — it can be inspected, diffed at the header level, and verified
 * by the existing L3 machinery. Compression would be a new format version.
 */
import { sha256Hex } from "./sha256.js";
import { WeiSQLError } from "./errors.js";
import type { ByteRange, ResourceMetadata, ResourceReader, ResourceReadOptions } from "./resource-reader.js";
import { validateByteRange } from "./resource-reader.js";

export const CONTAINER_MAGIC = "WSQLPKG1";
/** Latest version this build can write. */
export const CONTAINER_FORMAT_VERSION = "1.1.0";
/** Every version this build can read. */
export const CONTAINER_FORMAT_VERSIONS = ["1.0.0", "1.1.0"] as const;
const MAGIC_BYTES = 8;
const LENGTH_BYTES = 4;
const HEADER_START = MAGIC_BYTES + LENGTH_BYTES;

export interface ContainerEntry {
  path: string;
  /** Offset of the stored (possibly compressed) block inside the data section. */
  offset: number;
  /** Size after decompression; this is what the Manifest describes. */
  bytes: number;
  /** Size on disk; defaults to `bytes` when the container is uncompressed. */
  storedBytes?: number;
  sha256: string;
}

export interface ContainerHeader {
  formatVersion: string;
  /** Absent for uncompressed containers, including every 1.0.0 container. */
  compression?: "gzip";
  files: ContainerEntry[];
}

export interface ContainerFile {
  path: string;
  bytes: Uint8Array;
}

export interface CreateContainerOptions {
  /** Gzip each file and write format 1.1.0; defaults to false (1.0.0). */
  compress?: boolean;
}

function encoder() {
  return new TextEncoder();
}

function decoder() {
  return new TextDecoder("utf-8", { fatal: true });
}

/** BlobPart requires an ArrayBuffer; a Uint8Array may be backed by a shared buffer. */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bufferOf(bytes)]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bufferOf(bytes)]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Builds a container from in-memory files. Order is preserved in the header. */
export async function createContainer(files: readonly ContainerFile[], options: CreateContainerOptions = {}): Promise<Uint8Array> {
  const compress = options.compress === true;
  const formatVersion = compress ? "1.1.0" : "1.0.0";
  if (files.length === 0) throw new WeiSQLError("INVALID_ARGUMENT", "A container needs at least one file");
  const seen = new Set<string>();
  const entries: ContainerEntry[] = [];
  const storedBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    if (file.path.length === 0) throw new WeiSQLError("INVALID_ARGUMENT", "Container file paths must not be empty");
    try {
      assertSafeContainerPath(file.path);
    } catch {
      throw new WeiSQLError("INVALID_ARGUMENT", "Container file paths must stay inside the extraction root", { path: file.path });
    }
    if (seen.has(file.path)) throw new WeiSQLError("INVALID_ARGUMENT", `Duplicate container path '${file.path}'`);
    seen.add(file.path);
    const stored = compress ? await gzip(file.bytes) : file.bytes;
    storedBlocks.push(stored);
    entries.push({
      path: file.path,
      offset,
      bytes: file.bytes.byteLength,
      ...(compress ? { storedBytes: stored.byteLength } : {}),
      sha256: await sha256Hex(file.bytes),
    });
    offset += stored.byteLength;
  }
  const header: ContainerHeader = { formatVersion, ...(compress ? { compression: "gzip" as const } : {}), files: entries };
  const headerBytes = encoder().encode(JSON.stringify(header));
  const total = HEADER_START + headerBytes.byteLength + offset;
  const output = new Uint8Array(total);
  output.set(encoder().encode(CONTAINER_MAGIC), 0);
  new DataView(output.buffer).setUint32(MAGIC_BYTES, headerBytes.byteLength, true);
  output.set(headerBytes, HEADER_START);
  let position = HEADER_START + headerBytes.byteLength;
  for (const block of storedBlocks) {
    output.set(block, position);
    position += block.byteLength;
  }
  return output;
}

/**
 * Rejects entry paths that could escape the extraction root.
 *
 * A container header is untrusted input: an entry named `../../etc/passwd` must
 * fail while parsing, not when someone writes it to disk.
 */
export function assertSafeContainerPath(containerPath: string): void {
  const invalid = (reason: string) => new WeiSQLError("RESOURCE_INTEGRITY_FAILED", `Unsafe container path: ${reason}`, { path: containerPath });
  if (containerPath.length === 0) throw invalid("empty");
  if (containerPath.length > 1024) throw invalid("longer than 1024 characters");
  if (!/^[A-Za-z0-9._/-]+$/.test(containerPath)) throw invalid("only letters, digits, '.', '_', '-' and '/' are allowed");
  if (containerPath.startsWith("/")) throw invalid("must be relative");
  if (containerPath.includes("\\")) throw invalid("backslashes are not allowed");
  if (containerPath.endsWith("/")) throw invalid("must name a file");
  const segments = containerPath.split("/");
  if (segments.some(segment => segment.length === 0)) throw invalid("empty path segment");
  if (segments.some(segment => segment === "." || segment === "..")) throw invalid("'.' and '..' segments are not allowed");
}

export interface ParsedContainer {
  header: ContainerHeader;
  headerBytes: number;
  /** Byte offset where file data starts. */
  dataStart: number;
}

/** Parses and bounds-checks the container header without touching file contents. */
const MAGIC_BYTES_ARRAY = encoder().encode(CONTAINER_MAGIC);

/** Byte-wise magic check: decoding hostile bytes as UTF-8 would throw TypeError. */
function assertMagic(bytes: Uint8Array): void {
  let matches = bytes.byteLength >= MAGIC_BYTES;
  for (let index = 0; matches && index < MAGIC_BYTES; index++) {
    if (bytes[index] !== MAGIC_BYTES_ARRAY[index]) matches = false;
  }
  if (!matches) {
    const actual = [...bytes.subarray(0, Math.min(MAGIC_BYTES, bytes.byteLength))].map(byte => byte.toString(16).padStart(2, "0")).join(" ");
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container magic does not match", { expected: CONTAINER_MAGIC, actual });
  }
}

/** Parses and validates the JSON header against the size of the data section. */
function parseHeader(headerJson: Uint8Array, dataBytes: number): ContainerHeader {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder().decode(headerJson));
  } catch (cause) {
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container header is not valid JSON", { cause: String(cause) });
  }
  if (typeof parsed !== "object" || parsed === null) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container header must be an object");
  const header = parsed as { formatVersion?: unknown; compression?: unknown; files?: unknown };
  if (typeof header.formatVersion !== "string" || !(CONTAINER_FORMAT_VERSIONS as readonly string[]).includes(header.formatVersion)) {
    throw new WeiSQLError("FORMAT_VERSION_UNSUPPORTED", "Unsupported container format version", { supported: CONTAINER_FORMAT_VERSIONS, actual: header.formatVersion });
  }
  const formatVersion = header.formatVersion;
  if (header.compression !== undefined && header.compression !== "gzip") {
    throw new WeiSQLError("FORMAT_VERSION_UNSUPPORTED", "Unsupported container compression", { supported: ["gzip"], actual: header.compression });
  }
  if (formatVersion === "1.0.0" && header.compression !== undefined) {
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container 1.0.0 cannot declare compression", { compression: header.compression });
  }
  const compression = header.compression === "gzip" ? ("gzip" as const) : undefined;
  if (!Array.isArray(header.files) || header.files.length === 0) {
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container header must list at least one file");
  }
  const files: ContainerEntry[] = [];
  const seen = new Set<string>();
  let expectedOffset = 0;
  for (const [index, entry] of header.files.entries()) {
    if (typeof entry !== "object" || entry === null) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entry must be an object", { index });
    const record = entry as { path?: unknown; offset?: unknown; bytes?: unknown; storedBytes?: unknown; sha256?: unknown };
    if (typeof record.path !== "string" || record.path.length === 0) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entry is missing a path", { index });
    assertSafeContainerPath(record.path);
    if (seen.has(record.path)) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container lists a path twice", { path: record.path });
    seen.add(record.path);
    if (!Number.isSafeInteger(record.offset) || (record.offset as number) < 0) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entry has an invalid offset", { path: record.path });
    if (!Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entry has an invalid size", { path: record.path });
    if (record.storedBytes !== undefined && (!Number.isSafeInteger(record.storedBytes) || (record.storedBytes as number) < 0)) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entry has an invalid stored size", { path: record.path });
    }
    if (compression === undefined && record.storedBytes !== undefined && record.storedBytes !== record.bytes) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Uncompressed container entry cannot have a different stored size", { path: record.path });
    }
    if (typeof record.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(record.sha256)) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entry has an invalid digest", { path: record.path });
    const storedBytes = record.storedBytes === undefined ? (record.bytes as number) : (record.storedBytes as number);
    if ((record.offset as number) !== expectedOffset) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entries must be contiguous and ordered", { path: record.path });
    if ((record.offset as number) + storedBytes > dataBytes) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entry extends past the end of the data section", { path: record.path });
    expectedOffset += storedBytes;
    files.push({
      path: record.path,
      offset: record.offset as number,
      bytes: record.bytes as number,
      ...(compression === undefined ? {} : { storedBytes }),
      sha256: record.sha256,
    });
  }
  if (expectedOffset !== dataBytes) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container has trailing bytes not covered by its header", { dataBytes, covered: expectedOffset });
  return { formatVersion, ...(compression === undefined ? {} : { compression }), files };
}

export function parseContainer(bytes: Uint8Array): ParsedContainer {
  if (bytes.byteLength < HEADER_START) {
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container is shorter than its fixed header", { length: bytes.byteLength });
  }
  assertMagic(bytes);
  const headerBytes = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(MAGIC_BYTES, true);
  if (headerBytes === 0 || headerBytes > bytes.byteLength - HEADER_START) {
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container header length is out of bounds", { headerBytes, length: bytes.byteLength });
  }
  const dataStart = HEADER_START + headerBytes;
  const header = parseHeader(bytes.subarray(HEADER_START, dataStart), bytes.byteLength - dataStart);
  return { header, headerBytes, dataStart };
}

/** Random-access byte source; the container never needs the whole file in memory. */
export interface ContainerByteSource {
  size(): Promise<number>;
  readRange(range: ByteRange, options?: ResourceReadOptions): Promise<Uint8Array>;
}

/** In-memory source, useful for tests and for `ContainerReader`-style workflows. */
export function createBytesContainerSource(bytes: Uint8Array): ContainerByteSource {
  return {
    async size() {
      return bytes.byteLength;
    },
    async readRange(range, options) {
      validateByteRange(range);
      if (options?.signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Container read was cancelled");
      if (range.end > bytes.byteLength) {
        throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Range extends past the end of the container", { range, size: bytes.byteLength });
      }
      return bytes.slice(range.start, range.end);
    },
  };
}

export interface HttpContainerSourceOptions {
  url: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

/**
 * HTTP source for a `.wsql` served by a static host.
 *
 * Size discovery uses a one-byte Range request and `Content-Range`. If a host
 * ignores Range and returns 200 with the whole body, the body is sliced instead
 * of failing; that fallback costs a full download, which is what the caller was
 * trying to avoid, but it keeps the reader usable.
 */
export function createHttpContainerSource(options: HttpContainerSourceOptions): ContainerByteSource {
  const fetcher = (options.fetch ?? globalThis.fetch).bind(globalThis);
  let knownSize: number | undefined;

  async function size(): Promise<number> {
    if (knownSize !== undefined) return knownSize;
    const response = await fetcher(options.url, {
      method: "GET",
      headers: { Range: "bytes=0-0" },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) throw new WeiSQLError("RESOURCE_NOT_FOUND", "Container is not reachable", { status: response.status });
    const contentRange = response.headers.get("content-range");
    const match = typeof contentRange === "string" ? /^bytes\s+0-0\/(\d+)$/i.exec(contentRange.trim()) : null;
    if (match !== null) {
      knownSize = Number(match[1]);
      return knownSize;
    }
    // Range was ignored: the body is the whole container.
    const body = new Uint8Array(await response.arrayBuffer());
    knownSize = body.byteLength;
    return knownSize;
  }

  return {
    size,
    async readRange(range, readOptions) {
      validateByteRange(range);
      if (readOptions?.signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Container read was cancelled");
      if (range.end <= range.start) return new Uint8Array(0);
      const response = await fetcher(options.url, {
        method: "GET",
        headers: { Range: `bytes=${range.start}-${range.end - 1}` },
        ...(readOptions?.signal === undefined ? {} : { signal: readOptions.signal }),
      });
      if (!response.ok) throw new WeiSQLError("RESOURCE_NOT_FOUND", "Container range request failed", { status: response.status, range });
      const body = new Uint8Array(await response.arrayBuffer());
      if (response.status === 206) {
        if (body.byteLength !== range.end - range.start) {
          throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Server returned a partial range of the wrong length", {
            requested: range.end - range.start,
            received: body.byteLength,
          });
        }
        return body;
      }
      if (body.byteLength < range.end) {
        throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Server body is shorter than the requested range", { range, size: body.byteLength });
      }
      return body.slice(range.start, range.end);
    },
  };
}

/**
 * `ResourceReader` over a container accessed through Range requests.
 *
 * Only the fixed header and the JSON header are read at open time; each file is
 * fetched when it is asked for. This is the streaming counterpart to
 * `ContainerReader`, which requires the whole container as one buffer.
 */
export class StreamingContainerReader implements ResourceReader {
  private readonly index = new Map<string, ContainerEntry>();
  private closed = false;

  private constructor(
    private readonly source: ContainerByteSource,
    readonly header: ContainerHeader,
    private readonly dataStart: number,
  ) {
    for (const entry of header.files) this.index.set(entry.path, entry);
  }

  static async open(source: ContainerByteSource, options?: ResourceReadOptions): Promise<StreamingContainerReader> {
    const size = await source.size();
    if (!Number.isSafeInteger(size) || size < HEADER_START) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container is shorter than its fixed header", { length: size });
    }
    const prefix = await source.readRange({ start: 0, end: HEADER_START }, options);
    if (prefix.byteLength !== HEADER_START) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container header prefix has the wrong length", { expected: HEADER_START, actual: prefix.byteLength });
    }
    assertMagic(prefix);
    const headerBytes = new DataView(prefix.buffer, prefix.byteOffset, prefix.byteLength).getUint32(MAGIC_BYTES, true);
    if (headerBytes === 0 || headerBytes > size - HEADER_START) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container header length is out of bounds", { headerBytes, length: size });
    }
    const dataStart = HEADER_START + headerBytes;
    const headerJson = await source.readRange({ start: HEADER_START, end: dataStart }, options);
    if (headerJson.byteLength !== headerBytes) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container header has the wrong length", { expected: headerBytes, actual: headerJson.byteLength });
    }
    return new StreamingContainerReader(source, parseHeader(headerJson, size - dataStart), dataStart);
  }

  async read(path: string, options?: ResourceReadOptions): Promise<Uint8Array> {
    return this.readRange(path, { start: 0, end: this.entry(path).bytes }, options);
  }

  async readRange(path: string, range: ByteRange, options?: ResourceReadOptions): Promise<Uint8Array> {
    const entry = this.entry(path);
    validateByteRange(range);
    if (range.end > entry.bytes) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Range extends past the file inside the container", { path, range, size: entry.bytes });
    }
    const content = await this.content(entry, options);
    return content.slice(range.start, range.end);
  }

  async stat(path: string): Promise<ResourceMetadata> {
    return { size: this.entry(path).bytes, supportsRange: true };
  }

  async verify(paths?: readonly string[]): Promise<readonly { path: string; expected: string; actual: string }[]> {
    const mismatches: { path: string; expected: string; actual: string }[] = [];
    for (const path of paths ?? this.header.files.map(entry => entry.path)) {
      const entry = this.entry(path);
      let actual: string;
      try {
        actual = await sha256Hex(await this.content(entry));
      } catch {
        mismatches.push({ path, expected: entry.sha256, actual: "unreadable" });
        continue;
      }
      if (actual !== entry.sha256) mismatches.push({ path, expected: entry.sha256, actual });
    }
    return mismatches;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  /** Reads a whole stored entry and decompresses it when needed. */
  private async content(entry: ContainerEntry, options?: ResourceReadOptions): Promise<Uint8Array> {
    const storedBytes = entry.storedBytes ?? entry.bytes;
    const start = this.dataStart + entry.offset;
    const stored = await this.source.readRange({ start, end: start + storedBytes }, options);
    if (stored.byteLength !== storedBytes) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container read returned the wrong length", { path: entry.path, expected: storedBytes, actual: stored.byteLength });
    }
    if (this.header.compression !== "gzip") return stored;
    let content: Uint8Array;
    try {
      content = await gunzip(stored);
    } catch (cause) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entry could not be decompressed", { path: entry.path, cause: String(cause) });
    }
    if (content.byteLength !== entry.bytes) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entry has the wrong decompressed size", { path: entry.path, expected: entry.bytes, actual: content.byteLength });
    }
    return content;
  }

  private entry(path: string): ContainerEntry {
    if (this.closed) throw new WeiSQLError("DATABASE_CLOSED", "Container reader has been closed");
    const entry = this.index.get(path);
    if (entry === undefined) throw new WeiSQLError("INDEX_NOT_FOUND", `Container has no file '${path}'`);
    return entry;
  }
}

/**
 * ResourceReader over a container held in memory.
 *
 * Reads are served from the buffer, so it works in the browser and in Node
 * without a filesystem. `verify()` hashes every entry against the header.
 */
export class ContainerReader implements ResourceReader {
  private readonly parsed: ParsedContainer;
  private readonly index = new Map<string, ContainerEntry>();
  private closed = false;

  constructor(private readonly bytes: Uint8Array) {
    this.parsed = parseContainer(bytes);
    for (const entry of this.parsed.header.files) this.index.set(entry.path, entry);
  }

  get header(): Readonly<ContainerHeader> {
    return this.parsed.header;
  }

  async read(path: string, options?: ResourceReadOptions): Promise<Uint8Array> {
    return this.readRange(path, { start: 0, end: this.entry(path).bytes }, options);
  }

  async readRange(path: string, range: ByteRange, options?: ResourceReadOptions): Promise<Uint8Array> {
    const entry = this.entry(path);
    validateByteRange(range);
    if (range.end > entry.bytes) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Range extends past the file inside the container", { path, range, size: entry.bytes });
    }
    if (options?.signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Container read was cancelled");
    const content = await this.content(entry);
    return content.slice(range.start, range.end);
  }

  async stat(path: string): Promise<ResourceMetadata> {
    return { size: this.entry(path).bytes, supportsRange: true };
  }

  async verify(paths?: readonly string[]): Promise<readonly { path: string; expected: string; actual: string }[]> {
    const mismatches: { path: string; expected: string; actual: string }[] = [];
    const targets = paths ?? this.parsed.header.files.map(entry => entry.path);
    for (const path of targets) {
      const entry = this.entry(path);
      let actual: string;
      try {
        actual = await sha256Hex(await this.content(entry));
      } catch {
        // A block that cannot be decompressed is a mismatch, not a crash: verify
        // is the tool that reports corruption.
        mismatches.push({ path, expected: entry.sha256, actual: "unreadable" });
        continue;
      }
      if (actual !== entry.sha256) mismatches.push({ path, expected: entry.sha256, actual });
    }
    return mismatches;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private entry(path: string): ContainerEntry {
    if (this.closed) throw new WeiSQLError("DATABASE_CLOSED", "Container reader has been closed");
    const entry = this.index.get(path);
    if (entry === undefined) throw new WeiSQLError("INDEX_NOT_FOUND", `Container has no file '${path}'`);
    return entry;
  }

  /** Stored bytes, decompressed when the container declares gzip. */
  private async content(entry: ContainerEntry): Promise<Uint8Array> {
    const start = this.parsed.dataStart + entry.offset;
    const storedBytes = entry.storedBytes ?? entry.bytes;
    const stored = this.bytes.slice(start, start + storedBytes);
    if (this.parsed.header.compression !== "gzip") return stored;
    let content: Uint8Array;
    try {
      content = await gunzip(stored);
    } catch (cause) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entry could not be decompressed", { path: entry.path, cause: String(cause) });
    }
    if (content.byteLength !== entry.bytes) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entry has the wrong decompressed size", { path: entry.path, expected: entry.bytes, actual: content.byteLength });
    }
    return content;
  }
}
