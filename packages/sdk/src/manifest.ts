import { WeiSQLError } from "./errors.js";
import { validateResourcePath } from "./resource-path.js";
import type { ColumnDescriptor, FileDescriptor, TableDescriptor, VectorCollectionDescriptor, WeiSQLManifest } from "./types.js";

interface Issue { path: string; message: string }
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const datasetIdentifier = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const digest = /^[0-9a-f]{64}$/i;
const scalarTypes = new Set(["string", "int32", "int64", "float32", "float64", "boolean", "timestamp", "date", "json"]);
const metrics = new Set(["cosine", "l2", "ip"]);

/** Validate untrusted JSON and return the frozen WeiSQL Manifest V1 type. */
export function validateManifest(input: unknown): WeiSQLManifest {
  const issues: Issue[] = [];
  if (!record(input)) fail([{ path: "$", message: "manifest must be an object" }]);
  allowed(input, ["format", "formatVersion", "datasetId", "tables", "vectorCollections", "metadata"], "$", issues);
  if (input.format !== "weisql") issue(issues, "$.format", "must equal 'weisql'");
  if (input.formatVersion !== "1.0.0") {
    if (typeof input.formatVersion === "string") throw new WeiSQLError("FORMAT_VERSION_UNSUPPORTED", `Unsupported manifest format version '${input.formatVersion}'`, { supported: "1.0.0" });
    issue(issues, "$.formatVersion", "must equal '1.0.0'");
  }
  text(input.datasetId, "$.datasetId", issues, 1, 128);
  if (typeof input.datasetId === "string" && !datasetIdentifier.test(input.datasetId)) issue(issues, "$.datasetId", "must be a valid dataset identifier");
  const tables: TableDescriptor[] = [];
  if (!Array.isArray(input.tables)) issue(issues, "$.tables", "must be an array");
  else {
    if (input.tables.length > 10_000) issue(issues, "$.tables", "must contain at most 10000 items");
    input.tables.forEach((value, index) => { const parsed = table(value, `$.tables[${index}]`, issues); if (parsed) tables.push(parsed); });
  }
  const vectors: VectorCollectionDescriptor[] = [];
  if (!Array.isArray(input.vectorCollections)) issue(issues, "$.vectorCollections", "must be an array");
  else {
    if (input.vectorCollections.length > 10_000) issue(issues, "$.vectorCollections", "must contain at most 10000 items");
    input.vectorCollections.forEach((value, index) => { const parsed = vector(value, `$.vectorCollections[${index}]`, issues); if (parsed) vectors.push(parsed); });
  }
  metadata(input.metadata, issues);

  unique(tables.map(item => item.name), "$.tables", "table name", issues);
  unique(vectors.map(item => item.name), "$.vectorCollections", "vector collection name", issues);
  const resources = new Map<string, string>();
  const register = (file: FileDescriptor, path: string) => {
    const previous = resources.get(file.path);
    if (previous) issue(issues, `${path}.path`, `duplicates resource declared at ${previous}`);
    else resources.set(file.path, `${path}.path`);
  };
  tables.forEach((item, index) => register(item.file, `$.tables[${index}].file`));
  vectors.forEach((item, index) => {
    const path = `$.vectorCollections[${index}]`;
    register(item.data, `${path}.data`); register(item.idMap.data, `${path}.idMap.data`); register(item.idMap.offsets, `${path}.idMap.offsets`);
    if (item.index) register(item.index.file, `${path}.index.file`);
  });

  const tableByName = new Map(tables.map(value => [value.name, value]));
  vectors.forEach((collection, index) => {
    const path = `$.vectorCollections[${index}]`;
    const source = tableByName.get(collection.tableName);
    if (!source) issue(issues, `${path}.tableName`, "must reference an existing table");
    else {
      if (!source.columns.some(column => column.name === collection.idColumn)) issue(issues, `${path}.idColumn`, "must reference a source table column");
      else if (!source.primaryKey.includes(collection.idColumn)) issue(issues, `${path}.idColumn`, "must reference a primary key column");
    }
    const expected = BigInt(collection.count) * BigInt(collection.dimension) * 4n;
    if (expected > BigInt(Number.MAX_SAFE_INTEGER)) issue(issues, `${path}.data.bytes`, "computed vector size exceeds the safe integer range");
    else if (BigInt(collection.data.bytes) !== expected) issue(issues, `${path}.data.bytes`, `must equal count × dimension × 4 (${expected})`);
    if (collection.idMap.count !== collection.count) issue(issues, `${path}.idMap.count`, "must equal vector collection count");
    if (collection.idMap.data.format !== "jsonl") issue(issues, `${path}.idMap.data.format`, "must equal 'jsonl'");
    if (collection.idMap.offsets.format !== "uint64-le") issue(issues, `${path}.idMap.offsets.format`, "must equal 'uint64-le'");
    const offsetBytes = BigInt(collection.idMap.count) * 8n;
    if (BigInt(collection.idMap.offsets.bytes) !== offsetBytes) issue(issues, `${path}.idMap.offsets.bytes`, `must equal idMap.count × 8 (${offsetBytes})`);
  });
  if (issues.length) fail(issues);
  return input as unknown as WeiSQLManifest;
}

function table(value: unknown, path: string, issues: Issue[]): TableDescriptor | undefined {
  if (!record(value)) { issue(issues, path, "must be an object"); return; }
  allowed(value, ["name", "file", "format", "columns", "primaryKey"], path, issues);
  name(value.name, `${path}.name`, issues);
  const descriptor = file(value.file, `${path}.file`, issues);
  if (value.format !== "parquet") issue(issues, `${path}.format`, "must equal 'parquet'");
  const columns: ColumnDescriptor[] = [];
  if (!Array.isArray(value.columns) || value.columns.length === 0) issue(issues, `${path}.columns`, "must be a non-empty array");
  else {
    if (value.columns.length > 10_000) issue(issues, `${path}.columns`, "must contain at most 10000 items");
    value.columns.forEach((item, index) => { const parsed = column(item, `${path}.columns[${index}]`, issues); if (parsed) columns.push(parsed); });
  }
  unique(columns.map(item => item.name), `${path}.columns`, "column name", issues);
  const primaryKey = stringArray(value.primaryKey, `${path}.primaryKey`, issues, true);
  if (primaryKey) for (let i = 0; i < primaryKey.length; i++) {
    const primaryColumn = columns.find(item => item.name === primaryKey[i]);
    if (!primaryColumn) issue(issues, `${path}.primaryKey[${i}]`, "must reference a declared column");
    else if (primaryColumn.nullable) issue(issues, `${path}.primaryKey[${i}]`, "must reference a non-nullable column");
  }
  if (typeof value.name !== "string" || !descriptor || !primaryKey) return;
  return { name: value.name, file: descriptor, format: "parquet", columns, primaryKey };
}

function column(value: unknown, path: string, issues: Issue[]): ColumnDescriptor | undefined {
  if (!record(value)) { issue(issues, path, "must be an object"); return; }
  allowed(value, ["name", "type", "nullable"], path, issues); name(value.name, `${path}.name`, issues);
  if (typeof value.type !== "string" || !scalarTypes.has(value.type)) issue(issues, `${path}.type`, "is not a supported scalar type");
  if (typeof value.nullable !== "boolean") issue(issues, `${path}.nullable`, "must be a boolean");
  if (typeof value.name !== "string" || typeof value.type !== "string" || !scalarTypes.has(value.type) || typeof value.nullable !== "boolean") return;
  return { name: value.name, type: value.type as ColumnDescriptor["type"], nullable: value.nullable };
}

function vector(value: unknown, path: string, issues: Issue[]): VectorCollectionDescriptor | undefined {
  if (!record(value)) { issue(issues, path, "must be an object"); return; }
  allowed(value, ["name", "tableName", "idColumn", "count", "dimension", "metric", "encoding", "data", "idMap", "index"], path, issues);
  name(value.name, `${path}.name`, issues); name(value.tableName, `${path}.tableName`, issues); name(value.idColumn, `${path}.idColumn`, issues);
  integer(value.count, `${path}.count`, issues, 0); integer(value.dimension, `${path}.dimension`, issues, 1);
  if (typeof value.dimension === "number" && value.dimension > 65_536) issue(issues, `${path}.dimension`, "must be <= 65536");
  if (typeof value.metric !== "string" || !metrics.has(value.metric)) issue(issues, `${path}.metric`, "is not a supported metric");
  if (value.encoding !== "f32-le-row-major") issue(issues, `${path}.encoding`, "must equal 'f32-le-row-major'");
  const data = file(value.data, `${path}.data`, issues);
  const idMap = idMapValue(value.idMap, `${path}.idMap`, issues);
  let index: VectorCollectionDescriptor["index"];
  if (value.index !== undefined) index = indexValue(value.index, `${path}.index`, issues);
  if (typeof value.name !== "string" || typeof value.tableName !== "string" || typeof value.idColumn !== "string" || !Number.isSafeInteger(value.count) || (value.count as number) < 0 || !Number.isSafeInteger(value.dimension) || (value.dimension as number) < 1 || typeof value.metric !== "string" || !metrics.has(value.metric) || !data || !idMap) return;
  const result: VectorCollectionDescriptor = { name: value.name, tableName: value.tableName, idColumn: value.idColumn, count: value.count as number, dimension: value.dimension as number, metric: value.metric as VectorCollectionDescriptor["metric"], encoding: "f32-le-row-major", data, idMap };
  if (index) result.index = index;
  return result;
}

function idMapValue(value: unknown, path: string, issues: Issue[]): VectorCollectionDescriptor["idMap"] | undefined {
  if (!record(value)) { issue(issues, path, "must be an object"); return; }
  allowed(value, ["data", "offsets", "count", "uniqueIds"], path, issues);
  const data = formattedFile(value.data, `${path}.data`, issues); const offsets = formattedFile(value.offsets, `${path}.offsets`, issues);
  integer(value.count, `${path}.count`, issues, 0); if (typeof value.uniqueIds !== "boolean") issue(issues, `${path}.uniqueIds`, "must be a boolean");
  if (!data || !offsets || !Number.isSafeInteger(value.count) || (value.count as number) < 0 || typeof value.uniqueIds !== "boolean") return;
  return { data: data as VectorCollectionDescriptor["idMap"]["data"], offsets: offsets as VectorCollectionDescriptor["idMap"]["offsets"], count: value.count as number, uniqueIds: value.uniqueIds };
}

function indexValue(value: unknown, path: string, issues: Issue[]): NonNullable<VectorCollectionDescriptor["index"]> | undefined {
  if (!record(value)) { issue(issues, path, "must be an object"); return; }
  allowed(value, ["engine", "version", "file", "params"], path, issues); text(value.engine, `${path}.engine`, issues); text(value.version, `${path}.version`, issues);
  const descriptor = file(value.file, `${path}.file`, issues);
  const params = indexParams(value.params, `${path}.params`, issues);
  if (typeof value.engine !== "string" || typeof value.version !== "string" || !descriptor) return;
  return { engine: value.engine, version: value.version, file: descriptor, ...(params === undefined ? {} : { params }) };
}

/**
 * Engine-specific index build parameters.
 *
 * V1 keeps them as a flat number map instead of engine-specific fields: the
 * `engine` + `version` pair already identifies how to interpret them, and the
 * runtime refuses to load an index whose parameters it cannot reconstruct.
 */
function indexParams(value: unknown, path: string, issues: Issue[]): Readonly<Record<string, number>> | undefined {
  if (value === undefined) return undefined;
  if (!record(value)) { issue(issues, path, "must be an object"); return undefined; }
  const keys = Object.keys(value);
  if (keys.length > 32) issue(issues, path, "must declare at most 32 parameters");
  for (const key of keys) {
    if (!identifier.test(key)) issue(issues, `${path}.${key}`, "parameter names must be valid identifiers");
    const entry = value[key];
    if (typeof entry !== "number" || !Number.isFinite(entry)) issue(issues, `${path}.${key}`, "must be a finite number");
  }
  return value as Record<string, number>;
}

function file(value: unknown, path: string, issues: Issue[]): FileDescriptor | undefined {
  if (!record(value)) { issue(issues, path, "must be an object"); return; }
  allowed(value, ["path", "bytes", "sha256"], path, issues);
  let validPath = false;
  if (typeof value.path !== "string") issue(issues, `${path}.path`, "must be a string");
  else try { validateResourcePath(value.path); validPath = true; } catch { issue(issues, `${path}.path`, "must be a safe package-relative path"); }
  integer(value.bytes, `${path}.bytes`, issues, 0);
  if (typeof value.sha256 !== "string" || !digest.test(value.sha256)) issue(issues, `${path}.sha256`, "must contain 64 hexadecimal characters");
  if (!validPath || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0 || typeof value.sha256 !== "string" || !digest.test(value.sha256)) return;
  return { path: value.path as string, bytes: value.bytes as number, sha256: value.sha256 };
}

function formattedFile(value: unknown, path: string, issues: Issue[]): (FileDescriptor & { format: string }) | undefined {
  if (!record(value)) { issue(issues, path, "must be an object"); return; }
  const format = value.format; const clone = { ...value }; delete clone.format;
  const descriptor = file(clone, path, issues); text(format, `${path}.format`, issues);
  return descriptor && typeof format === "string" ? { ...descriptor, format } : undefined;
}

function metadata(value: unknown, issues: Issue[]): void {
  if (value === undefined) return;
  if (!record(value)) { issue(issues, "$.metadata", "must be an object"); return; }
  allowed(value, ["title", "description", "createdAt", "builderVersion"], "$.metadata", issues);
  for (const key of ["title", "description", "builderVersion"] as const) if (value[key] !== undefined && typeof value[key] !== "string") issue(issues, `$.metadata.${key}`, "must be a string");
  if (value.createdAt !== undefined && (typeof value.createdAt !== "string" || !dateTime(value.createdAt))) issue(issues, "$.metadata.createdAt", "must be an RFC 3339 date-time");
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function allowed(value: Record<string, unknown>, keys: readonly string[], path: string, issues: Issue[]): void { for (const key of Object.keys(value)) if (!keys.includes(key)) issue(issues, `${path}.${key}`, "is not allowed"); }
function text(value: unknown, path: string, issues: Issue[], min = 1, max = Number.MAX_SAFE_INTEGER): void { if (typeof value !== "string" || value.length < min || value.length > max) issue(issues, path, `must be a string with length ${min}..${max}`); }
function name(value: unknown, path: string, issues: Issue[]): void { if (typeof value !== "string" || value.length > 128 || !identifier.test(value)) issue(issues, path, "must be a valid identifier with length 1..128"); }
function integer(value: unknown, path: string, issues: Issue[], min: number): void { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) issue(issues, path, `must be a safe integer >= ${min}`); }
function stringArray(value: unknown, path: string, issues: Issue[], nonEmpty: boolean): string[] | undefined { if (!Array.isArray(value) || (nonEmpty && value.length === 0)) { issue(issues, path, nonEmpty ? "must be a non-empty array" : "must be an array"); return; } const result: string[] = []; value.forEach((item, index) => { text(item, `${path}[${index}]`, issues); if (typeof item === "string") result.push(item); }); unique(result, path, "value", issues); return result; }
function unique(values: readonly string[], path: string, label: string, issues: Issue[]): void { const seen = new Set<string>(); values.forEach((value, index) => { if (seen.has(value)) issue(issues, `${path}[${index}]`, `duplicate ${label}: ${value}`); seen.add(value); }); }
function dateTime(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)); }
function issue(issues: Issue[], path: string, message: string): void { issues.push({ path, message }); }
function fail(issues: Issue[]): never { throw new WeiSQLError("MANIFEST_INVALID", "Manifest validation failed", { issues }); }
