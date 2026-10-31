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
export const CONTAINER_FORMAT_VERSION = "1.0.0";
const MAGIC_BYTES = 8;
const LENGTH_BYTES = 4;
const HEADER_START = MAGIC_BYTES + LENGTH_BYTES;

export interface ContainerEntry {
  path: string;
  offset: number;
  bytes: number;
  sha256: string;
}

export interface ContainerHeader {
  formatVersion: string;
  files: ContainerEntry[];
}

export interface ContainerFile {
  path: string;
  bytes: Uint8Array;
}

export interface CreateContainerOptions {
  /** Header format version; defaults to 1.0.0. */
  formatVersion?: string;
}

function encoder() {
  return new TextEncoder();
}

function decoder() {
  return new TextDecoder("utf-8", { fatal: true });
}

/** Builds a container from in-memory files. Order is preserved in the header. */
export async function createContainer(files: readonly ContainerFile[], options: CreateContainerOptions = {}): Promise<Uint8Array> {
  const formatVersion = options.formatVersion ?? CONTAINER_FORMAT_VERSION;
  if (files.length === 0) throw new WeiSQLError("INVALID_ARGUMENT", "A container needs at least one file");
  const seen = new Set<string>();
  const entries: ContainerEntry[] = [];
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
    entries.push({ path: file.path, offset, bytes: file.bytes.byteLength, sha256: await sha256Hex(file.bytes) });
    offset += file.bytes.byteLength;
  }
  const header: ContainerHeader = { formatVersion, files: entries };
  const headerBytes = encoder().encode(JSON.stringify(header));
  const total = HEADER_START + headerBytes.byteLength + offset;
  const output = new Uint8Array(total);
  output.set(encoder().encode(CONTAINER_MAGIC), 0);
  new DataView(output.buffer).setUint32(MAGIC_BYTES, headerBytes.byteLength, true);
  output.set(headerBytes, HEADER_START);
  let position = HEADER_START + headerBytes.byteLength;
  for (const file of files) {
    output.set(file.bytes, position);
    position += file.bytes.byteLength;
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
export function parseContainer(bytes: Uint8Array): ParsedContainer {
  if (bytes.byteLength < HEADER_START) {
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container is shorter than its fixed header", { length: bytes.byteLength });
  }
  // Compare the magic byte-wise: decoding hostile bytes as UTF-8 would throw a
  // TypeError, and this parser must only ever surface WeiSQLError.
  const magic = encoder().encode(CONTAINER_MAGIC);
  let matches = true;
  for (let index = 0; index < MAGIC_BYTES; index++) {
    if (bytes[index] !== magic[index]) { matches = false; break; }
  }
  if (!matches) {
    const actual = [...bytes.subarray(0, MAGIC_BYTES)].map(byte => byte.toString(16).padStart(2, "0")).join(" ");
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container magic does not match", { expected: CONTAINER_MAGIC, actual });
  }
  const headerBytes = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(MAGIC_BYTES, true);
  if (headerBytes === 0 || headerBytes > bytes.byteLength - HEADER_START) {
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container header length is out of bounds", { headerBytes, length: bytes.byteLength });
  }
  const dataStart = HEADER_START + headerBytes;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder().decode(bytes.subarray(HEADER_START, dataStart)));
  } catch (cause) {
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container header is not valid JSON", { cause: String(cause) });
  }
  if (typeof parsed !== "object" || parsed === null) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container header must be an object");
  const header = parsed as { formatVersion?: unknown; files?: unknown };
  if (header.formatVersion !== CONTAINER_FORMAT_VERSION) {
    throw new WeiSQLError("FORMAT_VERSION_UNSUPPORTED", "Unsupported container format version", { supported: CONTAINER_FORMAT_VERSION, actual: header.formatVersion });
  }
  if (!Array.isArray(header.files) || header.files.length === 0) {
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container header must list at least one file");
  }
  const dataBytes = bytes.byteLength - dataStart;
  const files: ContainerEntry[] = [];
  const seen = new Set<string>();
  let expectedOffset = 0;
  for (const [index, entry] of header.files.entries()) {
    if (typeof entry !== "object" || entry === null) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entry must be an object", { index });
    const record = entry as { path?: unknown; offset?: unknown; bytes?: unknown; sha256?: unknown };
    if (typeof record.path !== "string" || record.path.length === 0) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entry is missing a path", { index });
    assertSafeContainerPath(record.path);
    if (seen.has(record.path)) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container lists a path twice", { path: record.path });
    seen.add(record.path);
    if (!Number.isSafeInteger(record.offset) || (record.offset as number) < 0) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entry has an invalid offset", { path: record.path });
    if (!Number.isSafeInteger(record.bytes) || (record.bytes as number) < 0) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entry has an invalid size", { path: record.path });
    if (typeof record.sha256 !== "string" || !/^[a-fA-F0-9]{64}$/.test(record.sha256)) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entry has an invalid digest", { path: record.path });
    if ((record.offset as number) !== expectedOffset) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entries must be contiguous and ordered", { path: record.path });
    if ((record.offset as number) + (record.bytes as number) > dataBytes) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container entry extends past the end of the data section", { path: record.path });
    expectedOffset += record.bytes as number;
    files.push({ path: record.path, offset: record.offset as number, bytes: record.bytes as number, sha256: record.sha256 });
  }
  if (expectedOffset !== dataBytes) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Container has trailing bytes not covered by its header", { dataBytes, covered: expectedOffset });
  return { header: { formatVersion: CONTAINER_FORMAT_VERSION, files }, headerBytes, dataStart };
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
    const start = this.parsed.dataStart + entry.offset + range.start;
    return this.bytes.slice(start, start + (range.end - range.start));
  }

  async stat(path: string): Promise<ResourceMetadata> {
    return { size: this.entry(path).bytes, supportsRange: true };
  }

  async verify(paths?: readonly string[]): Promise<readonly { path: string; expected: string; actual: string }[]> {
    const mismatches: { path: string; expected: string; actual: string }[] = [];
    const targets = paths ?? this.parsed.header.files.map(entry => entry.path);
    for (const path of targets) {
      const entry = this.entry(path);
      const actual = await sha256Hex(this.slice(entry));
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

  private slice(entry: ContainerEntry): Uint8Array {
    const start = this.parsed.dataStart + entry.offset;
    return this.bytes.slice(start, start + entry.bytes);
  }
}
