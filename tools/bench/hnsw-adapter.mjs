#!/usr/bin/env node
// End-to-end check for the HNSW adapter: same collection, same queries, compare
// Recall@K and distances against the TypeScript exact adapter, plus the
// post-filtering contract.
//
//   npm run build:hnsw-wasm
//   npm run build --workspace @weisql/sdk
//   node tools/bench/hnsw-adapter.mjs [path/to/weisql_vector_hnsw_wasm.wasm]

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_WASM = new URL(
  "../../crates/vector-hnsw-wasm/target/wasm32-unknown-unknown/release/weisql_vector_hnsw_wasm.wasm",
  import.meta.url,
);
const sdkUrl =
  process.env.WEISQL_SDK_DIST !== undefined
    ? pathToFileURL(resolve(process.env.WEISQL_SDK_DIST))
    : new URL("../../packages/sdk/dist/index.js", import.meta.url);

const { WeiSQLError, createExactVectorAdapter, createHnswWasmVectorAdapter, vectorDistance } = await import(sdkUrl.href);

const ROWS = 400;
const DIMENSION = 12;
const CLUSTERS = 5;
const TOP_K = 10;
const TOLERANCE = 1e-9;
const MIN_RECALL = 0.9;

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };
}

function buildVectors() {
  const next = lcg(11);
  const centers = Array.from({ length: CLUSTERS }, () =>
    Array.from({ length: DIMENSION }, () => next() * 20),
  );
  const flat = new Float32Array(ROWS * DIMENSION);
  for (let row = 0; row < ROWS; row++) {
    const center = centers[Math.min(CLUSTERS - 1, Math.floor((next() + 0.5) * CLUSTERS))];
    for (let column = 0; column < DIMENSION; column++) {
      flat[row * DIMENSION + column] = center[column] + next() * 0.5;
    }
  }
  return flat;
}

function buildResources(flat) {
  const lines = [];
  const offsets = new Uint8Array(ROWS * 8);
  const view = new DataView(offsets.buffer);
  let offset = 0;
  for (let row = 0; row < ROWS; row++) {
    const line = `${JSON.stringify({ row, id: `doc-${row}` })}\n`;
    view.setBigUint64(row * 8, BigInt(offset), true);
    lines.push(line);
    offset += new TextEncoder().encode(line).byteLength;
  }
  const ids = new TextEncoder().encode(lines.join(""));
  return new Map([
    ["vectors.f32", new Uint8Array(flat.buffer, flat.byteOffset, flat.byteLength)],
    ["ids.jsonl", ids],
    ["ids.offsets", offsets],
  ]);
}

function buildReader(resources) {
  return {
    async read(path) {
      const bytes = resources.get(path);
      if (bytes === undefined) throw new WeiSQLError("RESOURCE_NOT_FOUND", `missing resource ${path}`);
      return bytes.slice();
    },
    async readRange(path, { start, end }) {
      const bytes = resources.get(path);
      if (bytes === undefined) throw new WeiSQLError("RESOURCE_NOT_FOUND", `missing resource ${path}`);
      return bytes.slice(start, end);
    },
    async stat(path) {
      const bytes = resources.get(path);
      return bytes === undefined ? {} : { size: bytes.byteLength, supportsRange: true };
    },
    async close() {},
  };
}

function descriptor(metric, resources, index) {
  return {
    name: "documents",
    tableName: "documents",
    idColumn: "id",
    count: ROWS,
    dimension: DIMENSION,
    metric,
    encoding: "f32-le-row-major",
    data: { path: "vectors.f32", bytes: resources.get("vectors.f32").byteLength, sha256: "0".repeat(64) },
    ...(index === undefined ? {} : { index }),
    idMap: {
      data: { path: "ids.jsonl", bytes: resources.get("ids.jsonl").byteLength, sha256: "0".repeat(64), format: "jsonl" },
      offsets: { path: "ids.offsets", bytes: resources.get("ids.offsets").byteLength, sha256: "0".repeat(64), format: "uint64-le" },
      count: ROWS,
      uniqueIds: true,
    },
  };
}

const argument = process.argv[2];
const wasmUrl = argument === undefined ? DEFAULT_WASM : pathToFileURL(resolve(argument));
const wasmBytes = await readFile(wasmUrl);

const flat = buildVectors();
const resources = buildResources(flat);
const reader = buildReader(resources);

const exact = createExactVectorAdapter({ blockSize: 64 });
const hnsw = await createHnswWasmVectorAdapter({ module: wasmBytes, blockSize: 64, m: 12, efConstruction: 120, efSearch: 96 });
if (hnsw.capabilities.exactSearch !== false) throw new Error("HNSW adapter must report exactSearch: false");
if (hnsw.capabilities.postFiltering !== true) throw new Error("HNSW adapter must report postFiltering: true");

await exact.open({ manifest: {}, reader });
await hnsw.open({ manifest: {}, reader });

function rowOf(flatVectors, row) {
  return flatVectors.subarray(row * DIMENSION, (row + 1) * DIMENSION);
}

let comparisons = 0;
for (const metric of ["cosine", "l2"]) {
  const vector = descriptor(metric, resources);
  for (let queryIndex = 0; queryIndex < 10; queryIndex++) {
    const row = (queryIndex * 41) % ROWS;
    const query = Float32Array.from(rowOf(flat, row));
    const expected = await exact.search({ vector, query, topK: TOP_K });
    const actual = await hnsw.search({ vector, query, topK: TOP_K });

    if (actual.length !== TOP_K) throw new Error(`${metric} query ${row}: expected ${TOP_K} hits, got ${actual.length}`);
    const expectedIds = new Set(expected.map(hit => hit.row));
    let hits = 0;
    for (const hit of actual) {
      if (expectedIds.has(hit.row)) hits += 1;
      const reference = vectorDistance(query, rowOf(flat, hit.row), metric);
      if (Math.abs(hit.distance - reference) > TOLERANCE) {
        throw new Error(`${metric} query ${row}: distance ${hit.distance} != ${reference}`);
      }
      if (hit.diagnostics.backend !== "rust-hnsw-wasm" || hit.diagnostics.exact !== false) {
        throw new Error(`${metric}: unexpected diagnostics ${JSON.stringify(hit.diagnostics)}`);
      }
    }
    const recall = hits / expected.length;
    if (recall < MIN_RECALL) throw new Error(`${metric} query ${row}: recall ${recall.toFixed(3)} < ${MIN_RECALL}`);
    comparisons += 1;
  }
  console.log(`ok ${metric}: recall threshold ${MIN_RECALL} held for 10 queries`);

  const allowed = new Set(Array.from({ length: 80 }, (_, index) => index * 5));
  const filtered = await hnsw.search({ vector, query: Float32Array.from(rowOf(flat, 0)), topK: TOP_K, allowedRows: allowed });
  for (const hit of filtered) {
    if (!allowed.has(hit.row)) throw new Error(`filtered result ${hit.row} is outside allowedRows`);
  }
  if (filtered.length > TOP_K) throw new Error("filtered result exceeds topK");
  if (filtered.length > 0 && filtered[0].diagnostics.postFiltered !== true) {
    throw new Error("filtered results must be marked postFiltered");
  }
  console.log(`ok ${metric}-filtered: ${filtered.length} hits, all inside allowedRows`);
}

// Prebuilt graphs: export from one module, load through the adapter in another.
const prebuiltL2 = await buildPrebuilt(wasmBytes, flat, 1);
const prebuiltCosine = await buildPrebuilt(wasmBytes, flat, 0);

const prebuiltAdapter = await createHnswWasmVectorAdapter({
  module: wasmBytes,
  blockSize: 64,
  loadIndex: vector => (vector.metric === "l2" ? prebuiltL2 : undefined),
});
await prebuiltAdapter.open({ manifest: {}, reader });
const prebuiltVector = descriptor("l2", resources);
const prebuiltQuery = Float32Array.from(rowOf(flat, 3));
const prebuiltExpected = await exact.search({ vector: prebuiltVector, query: prebuiltQuery, topK: TOP_K });
const prebuiltHits = await prebuiltAdapter.search({ vector: prebuiltVector, query: prebuiltQuery, topK: TOP_K });
const prebuiltExpectedIds = new Set(prebuiltExpected.map(hit => hit.row));
let prebuiltHitsMatched = 0;
for (const hit of prebuiltHits) {
  if (prebuiltExpectedIds.has(hit.row)) prebuiltHitsMatched += 1;
  const reference = vectorDistance(prebuiltQuery, rowOf(flat, hit.row), "l2");
  if (Math.abs(hit.distance - reference) > TOLERANCE) throw new Error(`prebuilt distance ${hit.distance} != ${reference}`);
}
const prebuiltRecall = prebuiltHitsMatched / prebuiltExpected.length;
if (prebuiltRecall < MIN_RECALL) throw new Error(`prebuilt recall ${prebuiltRecall.toFixed(3)} < ${MIN_RECALL}`);
console.log(`ok prebuilt: ${prebuiltL2.length} bytes loaded, recall@${TOP_K} ${prebuiltRecall.toFixed(3)}`);
await prebuiltAdapter.close();

// A graph for another metric must be rejected, not silently rebuilt.
const staleAdapter = await createHnswWasmVectorAdapter({ module: wasmBytes, loadIndex: () => prebuiltCosine });
await staleAdapter.open({ manifest: {}, reader });
let staleCode;
try {
  await staleAdapter.search({ vector: descriptor("l2", resources), query: prebuiltQuery, topK: TOP_K });
} catch (error) {
  staleCode = error instanceof WeiSQLError ? error.code : String(error);
}
if (staleCode !== "RESOURCE_INTEGRITY_FAILED") throw new Error(`stale index should be rejected, got ${staleCode}`);
console.log("ok prebuilt: metric mismatch rejected");
await staleAdapter.close();

// Truncated bytes must fail loudly.
const corruptAdapter = await createHnswWasmVectorAdapter({ module: wasmBytes, loadIndex: () => prebuiltL2.slice(0, 32) });
await corruptAdapter.open({ manifest: {}, reader });
let corruptCode;
try {
  await corruptAdapter.search({ vector: descriptor("l2", resources), query: prebuiltQuery, topK: TOP_K });
} catch (error) {
  corruptCode = error instanceof WeiSQLError ? error.code : String(error);
}
if (corruptCode !== "RESOURCE_INTEGRITY_FAILED") throw new Error(`truncated index should be rejected, got ${corruptCode}`);
console.log("ok prebuilt: truncated bytes rejected");
await corruptAdapter.close();

// Manifest-declared index: loaded without ever touching the vector file.
resources.set("index.bin", prebuiltL2);
const manifestIndex = {
  engine: "weisql-hnsw",
  version: "1",
  file: { path: "index.bin", bytes: prebuiltL2.byteLength, sha256: "0".repeat(64) },
};
const strictReader = {
  ...reader,
  async readRange(path, range, options) {
    if (path === "vectors.f32") throw new Error("vector data must not be read when the Manifest declares an index");
    return reader.readRange(path, range, options);
  },
};
const manifestAdapter = await createHnswWasmVectorAdapter({ module: wasmBytes, blockSize: 64 });
if (manifestAdapter.capabilities.persistedIndex !== true) throw new Error("adapter must report persistedIndex: true");
await manifestAdapter.open({ manifest: {}, reader: strictReader });
const manifestVector = descriptor("l2", resources, manifestIndex);
const manifestHits = await manifestAdapter.search({ vector: manifestVector, query: prebuiltQuery, topK: TOP_K });
const manifestExpected = await exact.search({ vector: manifestVector, query: prebuiltQuery, topK: TOP_K });
const manifestExpectedIds = new Set(manifestExpected.map(hit => hit.row));
let manifestMatched = 0;
for (const hit of manifestHits) {
  if (manifestExpectedIds.has(hit.row)) manifestMatched += 1;
  const reference = vectorDistance(prebuiltQuery, rowOf(flat, hit.row), "l2");
  if (Math.abs(hit.distance - reference) > TOLERANCE) throw new Error(`manifest distance ${hit.distance} != ${reference}`);
}
const manifestRecall = manifestMatched / manifestExpected.length;
if (manifestRecall < MIN_RECALL) throw new Error(`manifest recall ${manifestRecall.toFixed(3)} < ${MIN_RECALL}`);
console.log(`ok manifest: ${prebuiltL2.byteLength} bytes loaded without reading vectors`);
await manifestAdapter.close();

for (const [label, index, expected] of [
  ["engine", { ...manifestIndex, engine: "usearch" }, "INDEX_NOT_FOUND"],
  ["version", { ...manifestIndex, version: "2.0" }, "RESOURCE_INTEGRITY_FAILED"],
  ["length", { ...manifestIndex, file: { ...manifestIndex.file, bytes: manifestIndex.file.bytes + 1 } }, "RESOURCE_INTEGRITY_FAILED"],
]) {
  const adapter = await createHnswWasmVectorAdapter({ module: wasmBytes });
  await adapter.open({ manifest: {}, reader: strictReader });
  let code;
  try {
    await adapter.search({ vector: descriptor("l2", resources, index), query: prebuiltQuery, topK: TOP_K });
  } catch (error) {
    code = error instanceof WeiSQLError ? error.code : String(error);
  }
  if (code !== expected) throw new Error(`manifest ${label}: expected ${expected}, got ${code}`);
  console.log(`ok manifest: ${label} rejected`);
  await adapter.close();
}

await exact.close();
await hnsw.close();

async function buildPrebuilt(wasmBytes, vectors, metricCode) {
  const { instance } = await WebAssembly.instantiate(wasmBytes, {});
  const api = instance.exports;
  const pointer = api.weisql_hnsw_alloc(vectors.byteLength);
  if (!pointer) throw new Error("prebuilt build allocation failed");
  new Float32Array(api.memory.buffer, pointer, vectors.length).set(vectors);
  const built = api.weisql_hnsw_build(pointer, ROWS, DIMENSION, metricCode, 12, 120, 96, 7, 0);
  api.weisql_hnsw_dealloc(pointer, vectors.byteLength);
  if (built !== 0) throw new Error(`prebuilt build failed with code ${built}`);
  const length = api.weisql_hnsw_serialized_len();
  const buffer = api.weisql_hnsw_alloc(length);
  if (!buffer) throw new Error("prebuilt save allocation failed");
  const written = api.weisql_hnsw_save(buffer, length);
  if (written !== length) throw new Error(`prebuilt save wrote ${written} of ${length}`);
  const snapshot = new Uint8Array(api.memory.buffer, buffer, length).slice();
  api.weisql_hnsw_dealloc(buffer, length);
  return snapshot;
}
console.log(`hnsw adapter parity: ${comparisons} unfiltered queries compared`);
