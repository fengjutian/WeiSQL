import { WeiSQLError } from "./errors.js";
import type { ManifestFile, ManifestTable, ManifestVector, WeiSQLManifest } from "./types.js";

const columns = new Set(["utf8", "int32", "int64", "float32", "float64", "boolean", "binary", "timestamp"]);
const metrics = new Set(["cosine", "l2", "ip"]);
const normalizations = new Set(["unit", "not-required-by-format", "unknown"]);
const sha256 = /^[a-fA-F0-9]{64}$/;
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const semver = /^(\d+)\.\d+\.\d+$/;
const safePathChars = /^[A-Za-z0-9._/-]+$/;

interface Issue { path: string; message: string }

export function validateManifest(input: unknown): WeiSQLManifest {
  const issues: Issue[] = [];
  if (!isObject(input)) fail([{ path: "$", message: "manifest must be an object" }]);

  allowed(input, ["format", "formatVersion", "datasetId", "createdAt", "metadata", "tables", "vectors", "features"], "$", issues);
  if (input.format !== "weisql-ai") issue(issues, "$.format", "must equal 'weisql-ai'");
  if (typeof input.formatVersion !== "string" || !semver.test(input.formatVersion)) issue(issues, "$.formatVersion", "must be a semantic version");
  else if (semver.exec(input.formatVersion)?.[1] !== "1")
    throw new WeiSQLError("FORMAT_VERSION_UNSUPPORTED", `Unsupported manifest format version '${input.formatVersion}'`, { supportedMajor: 1 });
  string(input.datasetId, "$.datasetId", issues, 1, 128);
  if (input.createdAt !== undefined && (typeof input.createdAt !== "string" || !isDateTime(input.createdAt)))
    issue(issues, "$.createdAt", "must be an RFC 3339 date-time");
  if (input.metadata !== undefined && !isObject(input.metadata)) issue(issues, "$.metadata", "must be an object");

  const tables: ManifestTable[] = [];
  if (!Array.isArray(input.tables) || input.tables.length === 0) issue(issues, "$.tables", "must be a non-empty array");
  else input.tables.forEach((value, index) => { const table = tableValue(value, `$.tables[${index}]`, issues); if (table) tables.push(table); });

  const vectors: ManifestVector[] = [];
  if (input.vectors !== undefined) {
    if (!Array.isArray(input.vectors)) issue(issues, "$.vectors", "must be an array");
    else input.vectors.forEach((value, index) => { const vector = vectorValue(value, `$.vectors[${index}]`, issues); if (vector) vectors.push(vector); });
  }
  if (input.features !== undefined) featuresValue(input.features, "$.features", issues);

  const seen = new Map<string, string>();
  for (const [path, location] of resources(tables, vectors)) {
    const canonical = canonicalPath(path);
    const previous = seen.get(canonical);
    if (previous) issue(issues, location, `duplicates canonical resource path declared at ${previous}`);
    else seen.set(canonical, location);
  }
  const tableMap = new Map(tables.map(table => [table.name, table]));
  for (let i = 0; i < vectors.length; i++) {
    const vector = vectors[i]!;
    const table = tableMap.get(vector.sourceTable);
    if (!table) issue(issues, `$.vectors[${i}].sourceTable`, "must reference an existing table");
    else {
      const column = table.schema.find(item => item.name === vector.idColumn);
      if (!column) issue(issues, `$.vectors[${i}].idColumn`, "must reference a source table column");
      if (table.primaryKey && !table.primaryKey.includes(vector.idColumn))
        issue(issues, `$.vectors[${i}].idColumn`, "must be part of the source table primary key");
    }
  }
  if (issues.length) fail(issues);
  return input as unknown as WeiSQLManifest;
}

function tableValue(value: unknown, path: string, issues: Issue[]): ManifestTable | undefined {
  if (!isObject(value)) { issue(issues, path, "must be an object"); return; }
  allowed(value, ["name", "schema", "primaryKey", "files"], path, issues);
  if (typeof value.name !== "string" || !identifier.test(value.name)) issue(issues, `${path}.name`, "must be a valid identifier");
  if (!Array.isArray(value.schema) || value.schema.length === 0) issue(issues, `${path}.schema`, "must be a non-empty array");
  else value.schema.forEach((column, i) => {
    const at = `${path}.schema[${i}]`;
    if (!isObject(column)) { issue(issues, at, "must be an object"); return; }
    allowed(column, ["name", "type", "nullable"], at, issues);
    string(column.name, `${at}.name`, issues);
    if (typeof column.type !== "string" || !columns.has(column.type)) issue(issues, `${at}.type`, "is unsupported");
    if (typeof column.nullable !== "boolean") issue(issues, `${at}.nullable`, "must be a boolean");
  });
  if (value.primaryKey !== undefined) stringArray(value.primaryKey, `${path}.primaryKey`, issues, true);
  const files = filesValue(value.files, `${path}.files`, issues);
  if (typeof value.name !== "string" || !Array.isArray(value.schema) || !files) return;
  const names = new Set(value.schema.filter(isObject).map(column => column.name).filter((name): name is string => typeof name === "string"));
  if (Array.isArray(value.primaryKey)) value.primaryKey.forEach((name, i) => { if (typeof name === "string" && !names.has(name)) issue(issues, `${path}.primaryKey[${i}]`, "must reference a schema column"); });
  return value as unknown as ManifestTable;
}

function vectorValue(value: unknown, path: string, issues: Issue[]): ManifestVector | undefined {
  if (!isObject(value)) { issue(issues, path, "must be an object"); return; }
  allowed(value, ["name", "sourceTable", "idColumn", "dimension", "elementType", "metric", "normalization", "files", "index"], path, issues);
  string(value.name, `${path}.name`, issues); string(value.sourceTable, `${path}.sourceTable`, issues); string(value.idColumn, `${path}.idColumn`, issues);
  integer(value.dimension, `${path}.dimension`, issues, 1);
  if (value.elementType !== "float32") issue(issues, `${path}.elementType`, "must equal 'float32'");
  if (typeof value.metric !== "string" || !metrics.has(value.metric)) issue(issues, `${path}.metric`, "is unsupported");
  if (value.normalization !== undefined && (typeof value.normalization !== "string" || !normalizations.has(value.normalization))) issue(issues, `${path}.normalization`, "is unsupported");
  const files = filesValue(value.files, `${path}.files`, issues);
  if (value.index !== undefined) {
    if (!isObject(value.index)) issue(issues, `${path}.index`, "must be an object");
    else {
      allowed(value.index, ["engine", "engineVersion", "path", "sha256"], `${path}.index`, issues);
      string(value.index.engine, `${path}.index.engine`, issues); safePath(value.index.path, `${path}.index.path`, issues);
      if (value.index.engineVersion !== undefined && typeof value.index.engineVersion !== "string") issue(issues, `${path}.index.engineVersion`, "must be a string");
      if (value.index.sha256 !== undefined && (typeof value.index.sha256 !== "string" || !sha256.test(value.index.sha256))) issue(issues, `${path}.index.sha256`, "must be a SHA-256 hex digest");
    }
  }
  if (!files) return;
  return value as unknown as ManifestVector;
}

function filesValue(value: unknown, path: string, issues: Issue[]): ManifestFile[] | undefined {
  if (!Array.isArray(value) || value.length === 0) { issue(issues, path, "must be a non-empty array"); return; }
  value.forEach((file, i) => {
    const at = `${path}[${i}]`;
    if (!isObject(file)) { issue(issues, at, "must be an object"); return; }
    allowed(file, ["path", "format", "rows", "bytes", "sha256"], at, issues);
    safePath(file.path, `${at}.path`, issues); string(file.format, `${at}.format`, issues);
    if (file.rows !== undefined) integer(file.rows, `${at}.rows`, issues, 0);
    integer(file.bytes, `${at}.bytes`, issues, 0);
    if (typeof file.sha256 !== "string" || !sha256.test(file.sha256)) issue(issues, `${at}.sha256`, "must be a SHA-256 hex digest");
  });
  return value as unknown as ManifestFile[];
}

function featuresValue(value: unknown, path: string, issues: Issue[]): void {
  if (!isObject(value)) { issue(issues, path, "must be an object"); return; }
  allowed(value, ["sql", "vectorSearch", "fullTextSearch", "hybridSearch"], path, issues);
  for (const key of Object.keys(value)) if (typeof value[key] !== "boolean") issue(issues, `${path}.${key}`, "must be a boolean");
}

function safePath(value: unknown, path: string, issues: Issue[]): void {
  if (typeof value !== "string" || value.length === 0 || !safePathChars.test(value) || value.startsWith("/") || value.includes("\\") || value.split("/").some(part => part === ".." || part === "" || part === ".") || /^[A-Za-z]:/.test(value) || value.includes(":"))
    issue(issues, path, "must be a safe relative resource path");
}
function canonicalPath(path: string): string { return path.split("/").filter(Boolean).join("/"); }
function *resources(tables: ManifestTable[], vectors: ManifestVector[]): Generator<[string, string]> {
  for (let i = 0; i < tables.length; i++) for (let j = 0; j < tables[i]!.files.length; j++) yield [tables[i]!.files[j]!.path, `$.tables[${i}].files[${j}].path`];
  for (let i = 0; i < vectors.length; i++) {
    for (let j = 0; j < vectors[i]!.files.length; j++) yield [vectors[i]!.files[j]!.path, `$.vectors[${i}].files[${j}].path`];
    if (vectors[i]!.index) yield [vectors[i]!.index!.path, `$.vectors[${i}].index.path`];
  }
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function allowed(value: Record<string, unknown>, keys: string[], path: string, issues: Issue[]): void { for (const key of Object.keys(value)) if (!keys.includes(key)) issue(issues, `${path}.${key}`, "is not allowed"); }
function string(value: unknown, path: string, issues: Issue[], min = 1, max = Number.MAX_SAFE_INTEGER): void { if (typeof value !== "string" || value.length < min || value.length > max) issue(issues, path, `must be a string with length ${min}..${max}`); }
function integer(value: unknown, path: string, issues: Issue[], min: number): void { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) issue(issues, path, `must be a safe integer >= ${min}`); }
function stringArray(value: unknown, path: string, issues: Issue[], unique: boolean): void { if (!Array.isArray(value)) { issue(issues, path, "must be an array"); return; } const seen = new Set<string>(); value.forEach((item, i) => { string(item, `${path}[${i}]`, issues); if (unique && typeof item === "string" && seen.has(item)) issue(issues, `${path}[${i}]`, "must be unique"); if (typeof item === "string") seen.add(item); }); }
function isDateTime(value: string): boolean { return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)); }
function issue(issues: Issue[], path: string, message: string): void { issues.push({ path, message }); }
function fail(issues: Issue[]): never { throw new WeiSQLError("MANIFEST_INVALID", "Manifest validation failed", { issues }); }
