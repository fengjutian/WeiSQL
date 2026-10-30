import { WeiSQLError } from "./errors.js";
import { validateResourcePath } from "./resource-path.js";
import type { ResourceReader } from "./resource-reader.js";
import { Sha256, toHex } from "./sha256.js";
import type { VectorCollectionDescriptor, WeiSQLManifest } from "./types.js";

/** Integrity strategy. `none` never touches a resource; `manifest` checks size only; `all` hashes content. */
export type IntegrityMode = "none" | "manifest" | "all";

export interface IntegrityOptions {
  mode?: IntegrityMode;
  /** Maximum declared bytes for a single resource, checked before any read. */
  maxResourceBytes?: number;
  /** Maximum declared bytes across all unique resources, checked before any read. */
  maxTotalBytes?: number;
  /** Bytes per range request while hashing. */
  chunkBytes?: number;
  signal?: AbortSignal;
}

/** Distinguishes "declared", "size verified" and "fully hashed" as the spec requires. */
export interface IntegrityReport {
  checkedResources: number;
  sizeVerified: number;
  hashesVerified: number;
  totalDeclaredBytes: number;
}

export interface VerifyManifestResourcesInput {
  manifest: Readonly<WeiSQLManifest>;
  reader: ResourceReader;
  options?: IntegrityOptions;
}

export type DeclaredResourceKind = "table" | "vector-data" | "id-map-data" | "id-map-offsets" | "index" | "text-data" | "text-offsets" | "text-lengths" | "text-ids" | "text-id-offsets";

export interface DeclaredResource {
  path: string;
  bytes: number;
  sha256: string;
  kind: DeclaredResourceKind;
  name: string;
}

const DEFAULT_MAX_RESOURCE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DEFAULT_CHUNK_BYTES = 1024 * 1024;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/**
 * L3 verification for every unique resource declared by a Manifest V1.
 *
 * The Manifest itself is untrusted, so paths are re-validated, budgets are
 * enforced before allocating, declared sizes are compared with `stat`, and in
 * `all` mode the complete byte stream is hashed incrementally.
 */
export async function verifyManifestResources(input: VerifyManifestResourcesInput): Promise<IntegrityReport> {
  const mode = input.options?.mode ?? "manifest";
  if (mode !== "none" && mode !== "manifest" && mode !== "all") {
    throw new WeiSQLError("INVALID_ARGUMENT", "verifyChecksums must be 'none', 'manifest' or 'all'", { mode });
  }
  if (mode === "none") return { checkedResources: 0, sizeVerified: 0, hashesVerified: 0, totalDeclaredBytes: 0 };

  const maxResourceBytes = positiveInteger(input.options?.maxResourceBytes, DEFAULT_MAX_RESOURCE_BYTES, "maxResourceBytes");
  const maxTotalBytes = positiveInteger(input.options?.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, "maxTotalBytes");
  const chunkBytes = positiveInteger(input.options?.chunkBytes, DEFAULT_CHUNK_BYTES, "chunkBytes");
  const signal = input.options?.signal;
  const readOptions = signal ? { signal } : undefined;

  const resources = declaredResources(input.manifest);
  let total = 0n;
  for (const resource of resources) total += BigInt(resource.bytes);
  if (total > MAX_SAFE) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Declared resources exceed the safe integer range", { totalDeclaredBytes: total.toString() });
  const totalDeclaredBytes = Number(total);
  if (totalDeclaredBytes > maxTotalBytes) {
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Declared resources exceed the total byte budget", { totalDeclaredBytes, maxTotalBytes });
  }
  for (const resource of resources) {
    if (resource.bytes > maxResourceBytes) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Resource exceeds the per-resource byte budget", { path: resource.path, bytes: resource.bytes, maxResourceBytes });
    }
  }

  const report: IntegrityReport = { checkedResources: 0, sizeVerified: 0, hashesVerified: 0, totalDeclaredBytes };
  const retained = new Map<string, Uint8Array>();

  for (const resource of resources) {
    checkCancelled(signal);
    validateResourcePath(resource.path);
    const metadata = await input.reader.stat(resource.path, readOptions);
    report.checkedResources++;
    if (metadata.size === undefined) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Reader did not report a resource size", { path: resource.path });
    }
    if (metadata.size !== resource.bytes) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Resource size does not match the Manifest", { path: resource.path, declared: resource.bytes, actual: metadata.size });
    }
    report.sizeVerified++;
    if (mode !== "all") continue;
    const keep = resource.kind === "id-map-data" || resource.kind === "id-map-offsets";
    const bytes = await hashResource(input.reader, resource, chunkBytes, signal, readOptions, keep);
    report.hashesVerified++;
    if (bytes !== undefined) retained.set(resource.path, bytes);
  }

  if (mode === "all") validateCollections(input.manifest, retained);
  return report;
}

/** Enumerates every unique resource declared by the Manifest, in a deterministic order. */
export function declaredResources(manifest: Readonly<WeiSQLManifest>): DeclaredResource[] {
  const seen = new Map<string, DeclaredResource>();
  const add = (kind: DeclaredResourceKind, name: string, file: { path: string; bytes: number; sha256: string }): void => {
    if (seen.has(file.path)) return;
    seen.set(file.path, { path: file.path, bytes: file.bytes, sha256: file.sha256, kind, name });
  };
  for (const table of manifest.tables) add("table", table.name, table.file);
  for (const collection of manifest.vectorCollections) {
    add("vector-data", collection.name, collection.data);
    add("id-map-data", collection.name, collection.idMap.data);
    add("id-map-offsets", collection.name, collection.idMap.offsets);
    if (collection.index) add("index", collection.name, collection.index.file);
  }
  for (const text of manifest.textIndexes ?? []) {
    add("text-data", text.name, text.data);
    add("text-offsets", text.name, text.termOffsets);
    add("text-lengths", text.name, text.docLengths);
    add("text-ids", text.name, text.idMap.data);
    add("text-id-offsets", text.name, text.idMap.offsets);
  }
  return [...seen.values()];
}

async function hashResource(
  reader: ResourceReader,
  resource: DeclaredResource,
  chunkBytes: number,
  signal: AbortSignal | undefined,
  readOptions: { signal?: AbortSignal } | undefined,
  retain: boolean,
): Promise<Uint8Array | undefined> {
  const hasher = new Sha256();
  const kept = retain ? new Uint8Array(resource.bytes) : undefined;
  for (let start = 0; start < resource.bytes; start += chunkBytes) {
    checkCancelled(signal);
    const end = Math.min(start + chunkBytes, resource.bytes);
    const chunk = await reader.readRange(resource.path, { start, end }, readOptions);
    if (chunk.byteLength !== end - start) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Resource returned fewer bytes than requested", { path: resource.path, expected: end - start, actual: chunk.byteLength });
    }
    hasher.update(chunk);
    kept?.set(chunk, start);
  }
  const actual = toHex(hasher.digest());
  const declared = resource.sha256.toLowerCase();
  if (actual !== declared) {
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Resource SHA-256 does not match the Manifest", { path: resource.path, declared, actual });
  }
  return kept;
}

function validateCollections(manifest: Readonly<WeiSQLManifest>, retained: Map<string, Uint8Array>): void {
  for (const collection of manifest.vectorCollections) {
    const expected = BigInt(collection.count) * BigInt(collection.dimension) * 4n;
    if (expected > MAX_SAFE) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Vector byte size exceeds the safe integer range", { collection: collection.name });
    }
    if (BigInt(collection.data.bytes) !== expected) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Vector bytes do not equal count × dimension × 4", { collection: collection.name, expected: expected.toString(), actual: collection.data.bytes });
    }
    const offsets = retained.get(collection.idMap.offsets.path);
    const data = retained.get(collection.idMap.data.path);
    if (offsets === undefined || data === undefined) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID Map resources were not read for content validation", { collection: collection.name });
    }
    validateIdMapContent(collection, offsets, data);
  }
}

/** Validates ID Map V1 offsets and JSONL records exactly as `RESOURCE_INTEGRITY_SPEC.md` requires. */
export function validateIdMapContent(collection: Readonly<VectorCollectionDescriptor>, offsets: Uint8Array, data: Uint8Array): void {
  const count = collection.count;
  const fail = (message: string, details: Readonly<Record<string, unknown>> = {}): never => {
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", message, { collection: collection.name, ...details });
  };
  if (offsets.byteLength !== count * 8) fail("ID Map offsets must be count × 8 bytes", { expected: count * 8, actual: offsets.byteLength });
  if (count === 0) {
    if (data.byteLength !== 0) fail("Empty ID Map must not contain records", { bytes: data.byteLength });
    return;
  }
  if (data.byteLength === 0) fail("ID Map data is empty but count is positive");
  const view = new DataView(offsets.buffer, offsets.byteOffset, offsets.byteLength);
  const starts: number[] = [];
  for (let row = 0; row < count; row++) {
    const value = view.getBigUint64(row * 8, true);
    if (value > MAX_SAFE) fail("ID Map offset exceeds the safe integer range", { row, offset: value.toString() });
    const start = Number(value);
    if (start >= data.byteLength) fail("ID Map offset exceeds the data file", { row, offset: start, dataBytes: data.byteLength });
    starts.push(start);
  }
  if (starts[0] !== 0) fail("The first ID Map offset must be zero", { offset: starts[0] });
  for (let row = 1; row < count; row++) {
    if (starts[row]! <= starts[row - 1]!) fail("ID Map offsets must be strictly increasing", { row, previous: starts[row - 1], offset: starts[row] });
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const seen = collection.idMap.uniqueIds ? new Set<string>() : undefined;
  for (let row = 0; row < count; row++) {
    const start = starts[row]!;
    const rawEnd = row + 1 < count ? starts[row + 1]! : data.byteLength;
    let end = rawEnd;
    if (end > start && data[end - 1] === 0x0a) end--;
    if (end > start && data[end - 1] === 0x0d) end--;
    if (end <= start) fail("ID Map record is empty", { row });
    let text: string;
    try {
      text = decoder.decode(data.subarray(start, end));
    } catch (cause) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID Map record is not valid UTF-8", { collection: collection.name, row, cause: String(cause) });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID Map record is not valid JSON", { collection: collection.name, row, cause: String(cause) });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) fail("ID Map record must be an object", { row });
    const record = parsed as { row?: unknown; id?: unknown };
    if (record.row !== row) fail("ID Map row does not match its offset index", { expected: row, actual: record.row });
    const id = record.id;
    const validId = (typeof id === "string" && id.length > 0) || (typeof id === "number" && Number.isSafeInteger(id));
    if (!validId) fail("ID Map contains an invalid business ID", { row, id: String(id) });
    if (seen) {
      const key = `${typeof id}:${String(id)}`;
      if (seen.has(key)) fail("ID Map business IDs must be unique", { row, id: String(id) });
      seen.add(key);
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new WeiSQLError("INVALID_ARGUMENT", `${name} must be a positive safe integer`, { [name]: value });
  return value;
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Integrity verification was cancelled");
}
