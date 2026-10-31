#!/usr/bin/env node
// End-to-end check for the HNSW WASM module: build a layered graph inside the
// module, search it, and compare Recall@K against a JavaScript brute-force L2
// scan. Proves the shim (not just the native crate) builds a usable graph.
//
//   cargo build --release --target wasm32-unknown-unknown \
//     --manifest-path crates/vector-hnsw-wasm/Cargo.toml
//   node tools/bench/hnsw-wasm.mjs [path/to/weisql_vector_hnsw_wasm.wasm]

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_WASM = new URL(
  "../../crates/vector-hnsw-wasm/target/wasm32-unknown-unknown/release/weisql_vector_hnsw_wasm.wasm",
  import.meta.url,
);
const ABI_VERSION = 2;
const METRIC_L2 = 1;
const ROWS = 1_000;
const DIMENSION = 16;
const TOP_K = 10;
const QUERIES = 20;
const MIN_RECALL = 0.9;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function lcg(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };
}

function clustered(rows, dimension, clusters, seed) {
  const next = lcg(seed);
  const centers = Array.from({ length: clusters }, () =>
    Array.from({ length: dimension }, () => next() * 20),
  );
  const vectors = new Float32Array(rows * dimension);
  for (let row = 0; row < rows; row++) {
    const pick = Math.min(clusters - 1, Math.floor((next() + 0.5) * clusters));
    const center = centers[pick];
    for (let column = 0; column < dimension; column++) {
      vectors[row * dimension + column] = center[column] + next() * 0.5;
    }
  }
  return vectors;
}

function l2(left, right, offset, dimension) {
  let squared = 0;
  for (let index = 0; index < dimension; index++) {
    const difference = left[index] - right[offset + index];
    squared += difference * difference;
  }
  return Math.sqrt(squared);
}

function bruteForce(vectors, rows, dimension, query, topK) {
  const scored = [];
  for (let row = 0; row < rows; row++) {
    scored.push({ row, distance: l2(query, vectors, row * dimension, dimension) });
  }
  scored.sort((left, right) => left.distance - right.distance || left.row - right.row);
  return scored.slice(0, topK);
}

const argument = process.argv[2];
const wasmUrl = argument === undefined ? DEFAULT_WASM : pathToFileURL(resolve(argument));

let bytes;
try {
  bytes = await readFile(wasmUrl);
} catch (error) {
  fail(
    `cannot read ${wasmUrl.pathname}: ${error.message}\n` +
      "build it with: cargo build --release --target wasm32-unknown-unknown --manifest-path crates/vector-hnsw-wasm/Cargo.toml",
  );
}

const { instance } = await WebAssembly.instantiate(bytes, {});
const api = instance.exports;
if (!(api.memory instanceof WebAssembly.Memory)) fail("wasm module does not export its linear memory");
if (api.weisql_hnsw_abi_version() !== ABI_VERSION) fail("unexpected HNSW WASM ABI version");
if (typeof api.weisql_hnsw_build !== "function") fail("missing weisql_hnsw_build");

const vectors = clustered(ROWS, DIMENSION, 8, 7);
const vectorBytes = vectors.byteLength;
const vectorPointer = api.weisql_hnsw_alloc(vectorBytes);
if (!vectorPointer) fail("allocation failed");
new Float32Array(api.memory.buffer, vectorPointer, vectors.length).set(vectors);

const buildStart = performance.now();
const built = api.weisql_hnsw_build(vectorPointer, ROWS, DIMENSION, METRIC_L2, 16, 200, 64, 7, 0);
const buildMs = performance.now() - buildStart;
if (built !== 0) fail(`build failed with code ${built}`);
if (api.weisql_hnsw_len() !== ROWS) fail("index length does not match the input");
if (api.weisql_hnsw_dimension() !== DIMENSION) fail("index dimension does not match the input");

const queryBytes = DIMENSION * Float32Array.BYTES_PER_ELEMENT;
const idBytes = TOP_K * Uint32Array.BYTES_PER_ELEMENT;
const distanceBytes = TOP_K * Float64Array.BYTES_PER_ELEMENT;
const queryPointer = api.weisql_hnsw_alloc(queryBytes);
const idPointer = api.weisql_hnsw_alloc(idBytes);
const distancePointer = api.weisql_hnsw_alloc(distanceBytes);
if (!queryPointer || !idPointer || !distancePointer) fail("allocation failed");

const query = new Float32Array(DIMENSION);
let hits = 0;
let total = 0;
const queryTimes = [];
for (let index = 0; index < QUERIES; index++) {
  const row = index * 37 % ROWS;
  query.set(vectors.subarray(row * DIMENSION, (row + 1) * DIMENSION));
  new Float32Array(api.memory.buffer, queryPointer, DIMENSION).set(query);

  const start = performance.now();
  const count = api.weisql_hnsw_search(queryPointer, TOP_K, idPointer, distancePointer);
  queryTimes.push(performance.now() - start);
  if (count !== TOP_K) fail(`query ${index}: expected ${TOP_K} hits, got ${count}`);

  const output = api.memory.buffer;
  const ids = new Uint32Array(output, idPointer, count);
  const distances = new Float64Array(output, distancePointer, count);
  const expected = bruteForce(vectors, ROWS, DIMENSION, query, TOP_K);
  const expectedIds = new Set(expected.map(hit => hit.row));

  for (let position = 0; position < count; position++) {
    const id = ids[position];
    if (id >= ROWS) fail(`query ${index}: id ${id} out of range`);
    const reference = l2(query, vectors, id * DIMENSION, DIMENSION);
    if (Math.abs(distances[position] - reference) > 1e-9) {
      fail(`query ${index}: distance ${distances[position]} != ${reference}`);
    }
    if (expectedIds.has(id)) hits += 1;
  }
  total += expected.length;
}

// Persist the graph, load it into a fresh module and compare the same query.
const probeQuery = Float32Array.from(vectors.subarray(0, DIMENSION));
new Float32Array(api.memory.buffer, queryPointer, DIMENSION).set(probeQuery);
const beforeCount = api.weisql_hnsw_search(queryPointer, TOP_K, idPointer, distancePointer);
const beforeIds = [...new Uint32Array(api.memory.buffer, idPointer, beforeCount)];
const beforeDistances = [...new Float64Array(api.memory.buffer, distancePointer, beforeCount)];

const serializedLength = api.weisql_hnsw_serialized_len();
if (serializedLength <= 0) fail("serialized length is zero after a build");
const snapshotPointer = api.weisql_hnsw_alloc(serializedLength);
if (!snapshotPointer) fail("allocation failed for the snapshot");
const written = api.weisql_hnsw_save(snapshotPointer, serializedLength);
if (written !== serializedLength) fail(`save wrote ${written} of ${serializedLength} bytes`);
const snapshot = new Uint8Array(api.memory.buffer, snapshotPointer, serializedLength).slice();
api.weisql_hnsw_dealloc(snapshotPointer, serializedLength);

const restoredModule = await WebAssembly.instantiate(bytes, {});
const restored = restoredModule.instance.exports;
if (restored.weisql_hnsw_abi_version() !== ABI_VERSION) fail("restored module reports a different ABI");

const restorePointer = restored.weisql_hnsw_alloc(snapshot.length);
new Uint8Array(restored.memory.buffer, restorePointer, snapshot.length).set(snapshot);
if (restored.weisql_hnsw_load(restorePointer, snapshot.length) !== 0) fail("restored module rejected the snapshot");
if (restored.weisql_hnsw_len() !== ROWS) fail("restored index length does not match");
if (restored.weisql_hnsw_dimension() !== DIMENSION) fail("restored index dimension does not match");

const restoredQueryPointer = restored.weisql_hnsw_alloc(queryBytes);
const restoredIdPointer = restored.weisql_hnsw_alloc(idBytes);
const restoredDistancePointer = restored.weisql_hnsw_alloc(distanceBytes);
new Float32Array(restored.memory.buffer, restoredQueryPointer, DIMENSION).set(probeQuery);
const afterCount = restored.weisql_hnsw_search(restoredQueryPointer, TOP_K, restoredIdPointer, restoredDistancePointer);
if (afterCount !== beforeCount) fail(`restored search returned ${afterCount} of ${beforeCount} hits`);
const afterIds = [...new Uint32Array(restored.memory.buffer, restoredIdPointer, afterCount)];
const afterDistances = [...new Float64Array(restored.memory.buffer, restoredDistancePointer, afterCount)];
for (let index = 0; index < afterCount; index++) {
  if (afterIds[index] !== beforeIds[index] || afterDistances[index] !== beforeDistances[index]) {
    fail(`restored hit ${index} differs: ${afterIds[index]}/${afterDistances[index]} vs ${beforeIds[index]}/${beforeDistances[index]}`);
  }
}
restored.weisql_hnsw_dealloc(restorePointer, snapshot.length);
restored.weisql_hnsw_dealloc(restoredQueryPointer, queryBytes);
restored.weisql_hnsw_dealloc(restoredIdPointer, idBytes);
restored.weisql_hnsw_dealloc(restoredDistancePointer, distanceBytes);

api.weisql_hnsw_dealloc(vectorPointer, vectorBytes);
api.weisql_hnsw_dealloc(queryPointer, queryBytes);
api.weisql_hnsw_dealloc(idPointer, idBytes);
api.weisql_hnsw_dealloc(distancePointer, distanceBytes);

const recall = hits / total;
queryTimes.sort((left, right) => left - right);
console.log(`engine=weisql-hnsw-wasm`);
console.log(`rows=${ROWS}`);
console.log(`dimension=${DIMENSION}`);
console.log(`top_k=${TOP_K}`);
console.log(`build_ms=${buildMs.toFixed(2)}`);
console.log(`p50_query_ms=${queryTimes[Math.floor(queryTimes.length / 2)].toFixed(4)}`);
console.log(`recall_at_k=${recall.toFixed(4)}`);
console.log(`persisted_bytes=${serializedLength}`);
console.log("save_load=identical");
if (recall < MIN_RECALL) fail(`recall ${recall.toFixed(3)} is below ${MIN_RECALL}`);
