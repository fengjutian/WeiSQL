/**
 * Single source of truth for the cross-environment parity check.
 *
 * Imported by the Node runner (`parity.mjs`) and served to the browser page
 * (`/parity/queries.js`), so both sides cannot drift apart.
 */

export const QUERIES = [
  { name: "self doc-001", vector: [1, 0], topK: 3 },
  { name: "self doc-002", vector: [0.9, 0.1], topK: 3 },
  { name: "self doc-003", vector: [0, 1], topK: 3 },
  { name: "diagonal", vector: [0.7071, 0.7071], topK: 2 },
  { name: "opposite", vector: [-1, 0], topK: 3 },
  { name: "topK 1", vector: [1, 0], topK: 1 },
  { name: "empty query", vector: [], topK: 3 },
  { name: "zero query", vector: [0, 0], topK: 3 },
];

/** BM25 queries; the text index name comes from the generator's default. */
export const TEXT_INDEX = "documents_title_text";

export const TEXT_QUERIES = [
  { name: "text dna", query: "dna", topK: 3 },
  { name: "text 细胞", query: "细胞", topK: 2 },
  { name: "text punctuation", query: "DNA!", topK: 2 },
  { name: "text unknown", query: "zzzz", topK: 3 },
  { name: "text empty", query: "   ", topK: 3 },
];

export const RAG_QUERY = { query: "dna", topK: 3, maxCharacters: 100 };

/** Manifest mutations whose validation error codes must match across runtimes. */
export const INVALID_MANIFESTS = [
  { name: "wrong format", mutate: manifest => { manifest.format = "sqlite"; } },
  { name: "bad version", mutate: manifest => { manifest.formatVersion = "2.0.0"; } },
  { name: "traversal path", mutate: manifest => { manifest.tables[0].file.path = "../secret.parquet"; } },
  { name: "unknown column type", mutate: manifest => { manifest.tables[0].columns[0].type = "varchar"; } },
  { name: "vector byte mismatch", mutate: manifest => { manifest.vectorCollections[0].data.bytes = 999; } },
  { name: "duplicate resource", mutate: manifest => { manifest.vectorCollections[0].idMap.offsets.path = manifest.vectorCollections[0].idMap.data.path; } },
];

/** Drops fields that legitimately differ between runtimes (timings, engines). */
export function summarizeHits(hits) {
  return {
    ids: hits.map(hit => hit.id),
    rows: hits.map(hit => hit.row),
    distances: hits.map(hit => Number(hit.distance)),
    exact: hits.map(hit => hit.diagnostics?.exact ?? null),
    backend: hits.length > 0 ? hits[0].diagnostics?.backend ?? null : null,
  };
}

export function summarizeError(error) {
  return { code: error?.code ?? "NO_CODE", message: String(error?.message ?? error) };
}

export function summarizeTextHits(hits) {
  return {
    ids: hits.map(hit => hit.id),
    rows: hits.map(hit => hit.row),
    scores: hits.map(hit => Number(hit.score)),
    backend: hits.length > 0 ? hits[0].diagnostics?.backend ?? null : null,
  };
}

export function summarizeRag(result) {
  return {
    ids: result.evidences.map(evidence => evidence.id),
    texts: result.evidences.map(evidence => evidence.text),
    ranks: result.evidences.map(evidence => evidence.rank),
    truncated: result.truncated,
    usedCharacters: result.usedCharacters,
    droppedHits: result.droppedHits,
  };
}

/**
 * SQL queries both engines must answer the same way.
 *
 * Only the intersection is listed: parameters are JSON scalars (no `Date` or
 * binary), and every statement is read-only. The error cases pin the codes the
 * two adapters must agree on.
 */
export const SQL_QUERIES = [
  { name: "sql rows", sql: "select id, title, category from documents order by id" },
  { name: "sql parameter", sql: "select id from documents where category = ? order by id", params: ["genetics"] },
  { name: "sql aggregate", sql: "select category, count(*) as n from documents group by category order by category" },
  { name: "sql cte", sql: "with g as (select id from documents where category = ?) select count(*) as n from g", params: ["genetics"] },
  { name: "sql literals", sql: "select 42 as i, 1.5 as f, true as b, null as z, 'x' as s" },
  { name: "sql error write", sql: "delete from documents" },
  { name: "sql error multi", sql: "select 1; select 2" },
  { name: "sql error unknown column", sql: "select missing from documents" },
  { name: "sql error write cte", sql: "with x as (select 1) delete from documents" },
];

/** Streaming path: the same rows must come out of `db.sqlStream()`. */
export const SQL_STREAM_QUERIES = [
  { name: "sql stream rows", sql: "select id, title, category from documents order by id" },
  { name: "sql stream parameter", sql: "select id from documents where category = ? order by id", params: ["genetics"] },
  { name: "sql stream error write", sql: "delete from documents" },
  { name: "sql stream error unknown column", sql: "select missing from documents" },
];

/** JSON-safe row values; both engines return bigint for COUNT(*). */
export function summarizeSqlRows(rows) {
  return rows.map(row => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeSqlValue(value)]),
  ));
}

function normalizeSqlValue(value) {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(normalizeSqlValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeSqlValue(item)]));
  }
  return value;
}
