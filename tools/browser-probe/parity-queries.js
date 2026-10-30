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
