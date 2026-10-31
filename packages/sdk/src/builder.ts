import { randomUUID } from "node:crypto";
import { copyFile, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { WeiSQLError } from "./errors.js";
import { verifyManifestResources } from "./integrity.js";
import type { IntegrityReport } from "./integrity.js";
import { validateManifest } from "./manifest.js";
import { signManifest } from "./signing.js";
import { compareIds } from "./sorted-id-index.js";
import { NodeFileResourceReader } from "./node-file-resource-reader.js";
import { Sha256, toHex } from "./sha256.js";
import type { ColumnDescriptor, FileDescriptor, VectorMetric, WeiSQLManifest } from "./types.js";

export type BuildStage = "CREATED" | "VALIDATING" | "BUILDING" | "VERIFYING" | "PUBLISHING" | "PUBLISHED" | "FAILED";

/** V1 Builder input: an already produced Parquet file. Parquet generation is out of scope. */
export interface BuilderTableInput {
  name: string;
  parquetPath: string;
  columns: readonly ColumnDescriptor[];
  primaryKey: readonly string[];
  /**
   * Primary-key values in Parquet row order. When provided, every vector ID is
   * checked for membership; when omitted the build records a warning because
   * crossing the Parquet content requires an L4 reader.
   */
  rowIds?: readonly (string | number)[];
}

export interface BuilderVectorInput {
  name: string;
  tableName: string;
  idColumn: string;
  metric: VectorMetric;
  /** One row-major vector per business ID, in ID Map row order. */
  vectors: readonly (Float32Array | readonly number[])[];
  ids: readonly (string | number)[];
  /** Required when the collection is empty; otherwise inferred from the first vector. */
  dimension?: number;
  uniqueIds?: boolean;
}

export interface BuildPackageOptions {
  outputDirectory: string;
  datasetId: string;
  tables: readonly BuilderTableInput[];
  vectorCollections: readonly BuilderVectorInput[];
  metadata?: NonNullable<WeiSQLManifest["metadata"]>;
  /**
   * Sign the Manifest while building it. Supplying both keys keeps the package
   * signed from the moment it is published, instead of relying on a later pass.
   */
  signing?: { privateKeyPem: string; publicKeyPem: string };
  /** Replaces an existing output directory only after the new package passed verification. */
  overwrite?: boolean;
  /** Optional stable job identifier for diagnostics; a random one is generated otherwise. */
  jobId?: string;
  signal?: AbortSignal;
}

export interface BuildArtifact {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BuildReport {
  jobId: string;
  datasetId: string;
  stage: "PUBLISHED";
  outputDirectory: string;
  manifest: WeiSQLManifest;
  artifacts: readonly BuildArtifact[];
  integrity: IntegrityReport;
  signature?: { keyId: string };
  warnings: readonly string[];
  startedAt: string;
  finishedAt: string;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const VECTOR_ROWS_PER_WRITE = 4096;
const ID_MAP_ROWS_PER_WRITE = 1024;
const OFFSETS_PER_WRITE = 8192;

/**
 * Builds an immutable multi-file package from an existing Parquet file, raw
 * vectors and business IDs.
 *
 * Files are written into a private staging directory next to the target, then
 * re-read, re-validated (L1/L2) and fully hashed (L3) before a single atomic
 * rename publishes them. A failed build never leaves a directory that a runtime
 * could mistake for a complete package.
 */
export async function buildPackage(options: BuildPackageOptions): Promise<BuildReport> {
  const startedAt = new Date().toISOString();
  const jobId = options.jobId ?? randomUUID();
  let stage: BuildStage = "CREATED";
  let failedStage: BuildStage = "CREATED";
  const warnings: string[] = [];
  const outputDirectory = path.resolve(options.outputDirectory);
  const stagingDirectory = `${outputDirectory}.staging-${jobId}`;

  try {
    stage = "VALIDATING";
    const config = await validateOptions(options, outputDirectory, warnings);
    stage = "BUILDING";
    await mkdir(stagingDirectory, { recursive: true });
    const descriptors = await writePackage(stagingDirectory, config);

    stage = "VERIFYING";
    const manifest = await writeAndVerifyManifest(stagingDirectory, config, descriptors);
    const integrity = await verifyStagedPackage(stagingDirectory, manifest, options.signal);
    const artifacts = await describeDirectory(stagingDirectory);

    stage = "PUBLISHING";
    await publish(stagingDirectory, outputDirectory, options.overwrite === true);

    return {
      jobId,
      datasetId: config.datasetId,
      stage: "PUBLISHED",
      outputDirectory,
      manifest,
      artifacts,
      integrity,
      ...(manifest.signature === undefined ? {} : { signature: { keyId: manifest.signature.keyId } }),
      warnings,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  } catch (cause) {
    failedStage = stage;
    let stagingCleaned = true;
    try {
      await rm(stagingDirectory, { recursive: true, force: true });
    } catch {
      stagingCleaned = false;
    }
    throw buildFailure(cause, { jobId, stage: failedStage, stagingCleaned, outputDirectory });
  }
}

interface NormalizedTable {
  name: string;
  parquetPath: string;
  columns: ColumnDescriptor[];
  primaryKey: string[];
  rowIds: (string | number)[] | undefined;
}

interface NormalizedVector {
  name: string;
  tableName: string;
  idColumn: string;
  metric: VectorMetric;
  dimension: number;
  count: number;
  ids: (string | number)[];
  vectors: Float32Array[];
  uniqueIds: boolean;
}

interface NormalizedConfig {
  datasetId: string;
  tables: NormalizedTable[];
  vectors: NormalizedVector[];
  metadata: NonNullable<WeiSQLManifest["metadata"]> | undefined;
  signing: { privateKeyPem: string; publicKeyPem: string } | undefined;
}

async function validateOptions(options: BuildPackageOptions, outputDirectory: string, warnings: string[]): Promise<NormalizedConfig> {
  if (typeof options.datasetId !== "string" || options.datasetId.length === 0) {
    throw new WeiSQLError("INVALID_ARGUMENT", "datasetId must be a non-empty string");
  }
  if (!Array.isArray(options.tables) || options.tables.length === 0) {
    throw new WeiSQLError("INVALID_ARGUMENT", "At least one table is required");
  }
  if (!Array.isArray(options.vectorCollections) || options.vectorCollections.length === 0) {
    throw new WeiSQLError("INVALID_ARGUMENT", "At least one vector collection is required");
  }
  await assertPublishTarget(outputDirectory, options.overwrite === true);

  // `Array.isArray` narrows readonly arrays to `any[]`, so restore the element types.
  const tableInputs: readonly BuilderTableInput[] = options.tables;
  const collectionInputs: readonly BuilderVectorInput[] = options.vectorCollections;

  const tables: NormalizedTable[] = [];
  const tableNames = new Set<string>();
  for (const table of tableInputs) {
    if (tableNames.has(table.name)) throw new WeiSQLError("INVALID_ARGUMENT", "Duplicate table name", { table: table.name });
    tableNames.add(table.name);
    if (table.columns.length === 0) throw new WeiSQLError("INVALID_ARGUMENT", "Table must declare at least one column", { table: table.name });
    const parquetPath = path.resolve(table.parquetPath);
    const info = await stat(parquetPath).catch((cause: unknown) => {
      throw new WeiSQLError("RESOURCE_NOT_FOUND", "Parquet file could not be read", { table: table.name, parquetPath, cause: String(cause) });
    });
    if (!info.isFile()) throw new WeiSQLError("INVALID_ARGUMENT", "Parquet input must be a regular file", { table: table.name, parquetPath });
    tables.push({
      name: table.name,
      parquetPath,
      columns: table.columns.map(column => ({ ...column })),
      primaryKey: [...table.primaryKey],
      rowIds: table.rowIds === undefined ? undefined : [...table.rowIds],
    });
  }

  const vectors: NormalizedVector[] = [];
  const vectorNames = new Set<string>();
  for (const collection of collectionInputs) {
    if (vectorNames.has(collection.name)) throw new WeiSQLError("INVALID_ARGUMENT", "Duplicate vector collection name", { collection: collection.name });
    vectorNames.add(collection.name);
    const table = tables.find(item => item.name === collection.tableName);
    if (!table) throw new WeiSQLError("INVALID_ARGUMENT", "Vector collection references an unknown table", { collection: collection.name, table: collection.tableName });
    if (!table.columns.some(column => column.name === collection.idColumn)) {
      throw new WeiSQLError("INVALID_ARGUMENT", "idColumn must reference a declared table column", { collection: collection.name, idColumn: collection.idColumn });
    }
    if (collection.ids.length !== collection.vectors.length) {
      throw new WeiSQLError("INVALID_ARGUMENT", "Vector IDs and vectors must have the same length", { collection: collection.name, ids: collection.ids.length, vectors: collection.vectors.length });
    }
    const uniqueIds = collection.uniqueIds !== false;
    const ids: (string | number)[] = [];
    const seenIds = new Set<string>();
    for (const [row, id] of collection.ids.entries()) {
      const valid = (typeof id === "string" && id.length > 0) || (typeof id === "number" && Number.isSafeInteger(id));
      if (!valid) throw new WeiSQLError("INVALID_ARGUMENT", "Business ID must be a non-empty string or a safe integer", { collection: collection.name, row, id: String(id) });
      if (uniqueIds) {
        const key = `${typeof id}:${String(id)}`;
        if (seenIds.has(key)) throw new WeiSQLError("INVALID_ARGUMENT", "Duplicate business ID", { collection: collection.name, row, id: String(id) });
        seenIds.add(key);
      }
      if (table.rowIds !== undefined && !table.rowIds.includes(id)) {
        throw new WeiSQLError("INVALID_ARGUMENT", "Business ID does not exist in the target table primary key", { collection: collection.name, row, id: String(id) });
      }
      ids.push(id);
    }
    if (table.rowIds === undefined) warnings.push(`id-membership-unverified:${collection.name}`);

    const dimension = collection.dimension ?? (collection.vectors[0]?.length ?? 0);
    if (!Number.isSafeInteger(dimension) || dimension <= 0) {
      throw new WeiSQLError("INVALID_ARGUMENT", "Vector dimension must be a positive integer; pass `dimension` for an empty collection", { collection: collection.name, dimension });
    }
    if (dimension > 65_536) throw new WeiSQLError("INVALID_ARGUMENT", "Vector dimension must be <= 65536", { collection: collection.name, dimension });
    const bytes = BigInt(collection.vectors.length) * BigInt(dimension) * 4n;
    if (bytes > MAX_SAFE) throw new WeiSQLError("INVALID_ARGUMENT", "Vector data exceeds the safe integer range", { collection: collection.name });

    const normalized: Float32Array[] = [];
    for (const [row, vector] of collection.vectors.entries()) {
      if (vector.length !== dimension) {
        throw new WeiSQLError("INVALID_ARGUMENT", "Vector dimension does not match the collection", { collection: collection.name, row, expected: dimension, actual: vector.length });
      }
      const typed = vector instanceof Float32Array ? new Float32Array(vector) : Float32Array.from(vector);
      let nonZero = false;
      for (let i = 0; i < typed.length; i++) {
        if (!Number.isFinite(typed[i]!)) throw new WeiSQLError("INVALID_ARGUMENT", "Vector contains a non-finite value", { collection: collection.name, row, dimension: i });
        if (typed[i] !== 0) nonZero = true;
      }
      if (collection.metric === "cosine" && !nonZero) throw new WeiSQLError("INVALID_ARGUMENT", "Cosine collections must not contain zero vectors", { collection: collection.name, row });
      normalized.push(typed);
    }

    vectors.push({
      name: collection.name,
      tableName: collection.tableName,
      idColumn: collection.idColumn,
      metric: collection.metric,
      dimension,
      count: normalized.length,
      ids,
      vectors: normalized,
      uniqueIds,
    });
  }

  return { datasetId: options.datasetId, tables, vectors, metadata: options.metadata, signing: options.signing };
}

async function assertPublishTarget(outputDirectory: string, overwrite: boolean): Promise<void> {
  const root = path.parse(outputDirectory).root;
  const cwd = process.cwd();
  if (outputDirectory === root || outputDirectory === cwd || cwd.startsWith(`${outputDirectory}${path.sep}`)) {
    throw new WeiSQLError("INVALID_ARGUMENT", "Refusing to publish into a filesystem root, the working directory or its ancestor", { outputDirectory });
  }
  const existing = await stat(outputDirectory).catch(() => undefined);
  if (existing === undefined) return;
  if (!overwrite) throw new WeiSQLError("INVALID_ARGUMENT", "Output directory already exists; pass overwrite to replace it", { outputDirectory });
  if (!existing.isDirectory()) throw new WeiSQLError("INVALID_ARGUMENT", "Output path exists and is not a directory", { outputDirectory });
}

interface WrittenDescriptors {
  tables: Map<string, FileDescriptor>;
  vectors: Map<string, { data: FileDescriptor; idMapData: FileDescriptor & { format: "jsonl" }; idMapOffsets: FileDescriptor & { format: "uint64-le" }; idIndexData?: FileDescriptor & { format: "jsonl" }; idIndexOffsets?: FileDescriptor & { format: "uint64-le" } }>;
}

async function writePackage(stagingDirectory: string, config: NormalizedConfig): Promise<WrittenDescriptors> {
  await mkdir(path.join(stagingDirectory, "data"), { recursive: true });
  await mkdir(path.join(stagingDirectory, "vectors"), { recursive: true });

  const tables = new Map<string, FileDescriptor>();
  for (const table of config.tables) {
    const relative = `data/${table.name}.parquet`;
    const target = path.join(stagingDirectory, ...relative.split("/"));
    await copyFile(table.parquetPath, target);
    tables.set(table.name, await describeFile(stagingDirectory, relative));
  }

  const vectors = new Map<string, { data: FileDescriptor; idMapData: FileDescriptor & { format: "jsonl" }; idMapOffsets: FileDescriptor & { format: "uint64-le" }; idIndexData?: FileDescriptor & { format: "jsonl" }; idIndexOffsets?: FileDescriptor & { format: "uint64-le" } }>();
  for (const collection of config.vectors) {
    const dataPath = `vectors/${collection.name}.f32`;
    const idMapPath = `vectors/${collection.name}.id-map.jsonl`;
    const offsetsPath = `vectors/${collection.name}.id-map.offsets`;
    await writeVectorFile(path.join(stagingDirectory, ...dataPath.split("/")), collection);
    await writeIdMapFiles(path.join(stagingDirectory, ...idMapPath.split("/")), path.join(stagingDirectory, ...offsetsPath.split("/")), collection);
    const data = await describeFile(stagingDirectory, dataPath);
    const idMapData = await describeFile(stagingDirectory, idMapPath);
    const idMapOffsets = await describeFile(stagingDirectory, offsetsPath);
    const entry: { data: FileDescriptor; idMapData: FileDescriptor & { format: "jsonl" }; idMapOffsets: FileDescriptor & { format: "uint64-le" }; idIndexData?: FileDescriptor & { format: "jsonl" }; idIndexOffsets?: FileDescriptor & { format: "uint64-le" } } = {
      data,
      idMapData: { ...idMapData, format: "jsonl" },
      idMapOffsets: { ...idMapOffsets, format: "uint64-le" },
    };
    if (collection.uniqueIds && collection.count > 0) {
      const indexPath = `vectors/${collection.name}.id-index.jsonl`;
      const indexOffsetsPath = `vectors/${collection.name}.id-index.offsets`;
      await writeIdIndexFiles(path.join(stagingDirectory, ...indexPath.split("/")), path.join(stagingDirectory, ...indexOffsetsPath.split("/")), collection);
      entry.idIndexData = { ...(await describeFile(stagingDirectory, indexPath)), format: "jsonl" };
      entry.idIndexOffsets = { ...(await describeFile(stagingDirectory, indexOffsetsPath)), format: "uint64-le" };
    }
    vectors.set(collection.name, entry);
  }
  return { tables, vectors };
}

async function writeVectorFile(filename: string, collection: NormalizedVector): Promise<void> {
  const rowBytes = collection.dimension * 4;
  const rowsPerWrite = Math.max(1, Math.min(VECTOR_ROWS_PER_WRITE, collection.count));
  const handle = await open(filename, "w");
  try {
    if (collection.count === 0) return;
    const buffer = new Uint8Array(rowsPerWrite * rowBytes);
    const view = new DataView(buffer.buffer);
    for (let start = 0; start < collection.count; start += rowsPerWrite) {
      const rows = Math.min(rowsPerWrite, collection.count - start);
      for (let row = 0; row < rows; row++) {
        const vector = collection.vectors[start + row]!;
        for (let i = 0; i < collection.dimension; i++) view.setFloat32((row * collection.dimension + i) * 4, vector[i]!, true);
      }
      await handle.write(buffer, 0, rows * rowBytes);
    }
  } finally {
    await handle.close();
  }
}

async function writeIdMapFiles(dataFilename: string, offsetsFilename: string, collection: NormalizedVector): Promise<void> {
  const encoder = new TextEncoder();
  const starts: bigint[] = [];
  let offset = 0n;
  const dataHandle = await open(dataFilename, "w");
  try {
    let pending: Uint8Array[] = [];
    let pendingBytes = 0;
    const flush = async (): Promise<void> => {
      if (pendingBytes === 0) return;
      const merged = new Uint8Array(pendingBytes);
      let cursor = 0;
      for (const part of pending) {
        merged.set(part, cursor);
        cursor += part.byteLength;
      }
      await dataHandle.write(merged, 0, merged.byteLength);
      pending = [];
      pendingBytes = 0;
    };
    for (let row = 0; row < collection.count; row++) {
      const line = encoder.encode(`${JSON.stringify({ row, id: collection.ids[row] })}\n`);
      starts.push(offset);
      offset += BigInt(line.byteLength);
      pending.push(line);
      pendingBytes += line.byteLength;
      if (pending.length >= ID_MAP_ROWS_PER_WRITE) await flush();
    }
    await flush();
  } finally {
    await dataHandle.close();
  }

  const offsetsHandle = await open(offsetsFilename, "w");
  try {
    if (starts.length === 0) return;
    for (let start = 0; start < starts.length; start += OFFSETS_PER_WRITE) {
      const slice = starts.slice(start, start + OFFSETS_PER_WRITE);
      const buffer = new Uint8Array(slice.length * 8);
      const view = new DataView(buffer.buffer);
      slice.forEach((value, index) => view.setBigUint64(index * 8, value, true));
      await offsetsHandle.write(buffer, 0, buffer.byteLength);
    }
  } finally {
    await offsetsHandle.close();
  }
}

async function writeIdIndexFiles(dataFilename: string, offsetsFilename: string, collection: NormalizedVector): Promise<void> {
  const pairs = collection.ids.map((id, row) => ({ id, row })).sort((left, right) => compareIds(left.id, right.id));
  const encoder = new TextEncoder();
  const starts: bigint[] = [];
  let offset = 0n;
  const dataHandle = await open(dataFilename, "w");
  try {
    for (const pair of pairs) {
      starts.push(offset);
      const line = encoder.encode(`${JSON.stringify({ id: pair.id, row: pair.row })}\n`);
      await dataHandle.write(line);
      offset += BigInt(line.byteLength);
    }
  } finally {
    await dataHandle.close();
  }
  const offsetsHandle = await open(offsetsFilename, "w");
  try {
    const offsets = new Uint8Array(starts.length * 8);
    const view = new DataView(offsets.buffer);
    starts.forEach((start, index) => view.setBigUint64(index * 8, start, true));
    await offsetsHandle.write(offsets);
  } finally {
    await offsetsHandle.close();
  }
}

function buildManifest(config: NormalizedConfig, written: WrittenDescriptors): WeiSQLManifest {
  const manifest: WeiSQLManifest = {
    format: "weisql",
    formatVersion: "1.0.0",
    datasetId: config.datasetId,
    tables: config.tables.map(table => ({
      name: table.name,
      file: written.tables.get(table.name)!,
      format: "parquet" as const,
      columns: table.columns.map(column => ({ ...column })),
      primaryKey: [...table.primaryKey],
    })),
    vectorCollections: config.vectors.map(collection => {
      const files = written.vectors.get(collection.name)!;
      return {
        name: collection.name,
        tableName: collection.tableName,
        idColumn: collection.idColumn,
        count: collection.count,
        dimension: collection.dimension,
        metric: collection.metric,
        encoding: "f32-le-row-major" as const,
        data: files.data,
        idMap: {
          data: files.idMapData,
          offsets: files.idMapOffsets,
          count: collection.count,
          uniqueIds: collection.uniqueIds,
        },
        ...(files.idIndexData === undefined || files.idIndexOffsets === undefined ? {} : {
          idIndex: {
            data: files.idIndexData,
            offsets: files.idIndexOffsets,
            count: collection.count,
            idType: typeof collection.ids[0] === "number" ? "integer" as const : "string" as const,
            uniqueIds: true,
          },
        }),
      };
    }),
  };
  if (config.metadata !== undefined) manifest.metadata = { ...config.metadata, builderVersion: config.metadata.builderVersion ?? "weisql-builder/0.1.0" };
  return manifest;
}

async function writeAndVerifyManifest(stagingDirectory: string, config: NormalizedConfig, written: WrittenDescriptors): Promise<WeiSQLManifest> {
  const unsigned = buildManifest(config, written);
  const manifest = validateManifest(
    config.signing === undefined
      ? unsigned
      : await signManifest(unsigned, { privateKeyPem: config.signing.privateKeyPem, publicKeyPem: config.signing.publicKeyPem }),
  );
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(path.join(stagingDirectory, "manifest.json"), serialized, "utf8");

  const reloaded = JSON.parse(await readFile(path.join(stagingDirectory, "manifest.json"), "utf8"));
  return validateManifest(reloaded);
}

async function verifyStagedPackage(stagingDirectory: string, manifest: WeiSQLManifest, signal: AbortSignal | undefined): Promise<IntegrityReport> {
  const reader = new NodeFileResourceReader({ rootDirectory: stagingDirectory });
  try {
    return await verifyManifestResources({
      manifest,
      reader,
      options: { mode: "all", ...(signal === undefined ? {} : { signal }) },
    });
  } finally {
    await reader.close();
  }
}

async function describeDirectory(directory: string): Promise<BuildArtifact[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const artifacts: BuildArtifact[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = path.join(entry.parentPath, entry.name);
    const relative = path.relative(directory, absolute).split(path.sep).join("/");
    const descriptor = await describeFile(directory, relative);
    artifacts.push({ path: relative, bytes: descriptor.bytes, sha256: descriptor.sha256 });
  }
  return artifacts.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}

async function describeFile(rootDirectory: string, relativePath: string): Promise<FileDescriptor> {
  const absolute = path.join(rootDirectory, ...relativePath.split("/"));
  const info = await stat(absolute);
  const hasher = new Sha256();
  const handle = await open(absolute, "r");
  try {
    const buffer = new Uint8Array(1024 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hasher.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return { path: relativePath, bytes: info.size, sha256: toHex(hasher.digest()) };
}

async function publish(stagingDirectory: string, outputDirectory: string, overwrite: boolean): Promise<void> {
  const existing = await stat(outputDirectory).catch(() => undefined);
  if (existing === undefined) {
    await renameAtomically(stagingDirectory, outputDirectory);
    return;
  }
  if (!overwrite) throw new WeiSQLError("INVALID_ARGUMENT", "Output directory already exists; pass overwrite to replace it", { outputDirectory });
  const backup = `${outputDirectory}.old-${randomUUID()}`;
  await rename(outputDirectory, backup);
  try {
    await renameAtomically(stagingDirectory, outputDirectory);
  } catch (cause) {
    await rename(backup, outputDirectory).catch(() => undefined);
    throw cause;
  }
  await rm(backup, { recursive: true, force: true }).catch(() => undefined);
}

async function renameAtomically(stagingDirectory: string, outputDirectory: string): Promise<void> {
  try {
    await rename(stagingDirectory, outputDirectory);
  } catch (cause) {
    throw new WeiSQLError("RESOURCE_READ_FAILED", "Package could not be published atomically", { outputDirectory, cause: String(cause) });
  }
}

function buildFailure(cause: unknown, context: { jobId: string; stage: BuildStage; stagingCleaned: boolean; outputDirectory: string }): WeiSQLError {
  if (cause instanceof WeiSQLError) {
    return new WeiSQLError(cause.code, cause.message, { ...(cause.details ?? {}), ...context });
  }
  return new WeiSQLError("INTERNAL_ERROR", "Package build failed", { ...context, cause: String(cause) });
}
