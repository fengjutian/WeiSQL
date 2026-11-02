#!/usr/bin/env node
// ANN evaluation harness for the pure-Rust HNSW engine.
//
//   node tools/bench/hnsw-dataset.mjs [--file vectors.f32 --rows N --dim D]
//        [--distribution clustered|random] [--metric cosine|l2|ip]
//        [--queries 50] [--top-k 10]
//        [--m 16] [--ef-construction 200] [--ef-search 64]
//        [--wasm path/to/weisql_vector_hnsw_wasm.wasm] [--min-recall 0.95]
//
// Without `--file` it generates deterministic clustered vectors, so the same
// command works as a smoke benchmark. With `--file` it reads raw little-endian
// float32 row-major embeddings (the layout of `.f32` dumps and the SDK vector
// blocks) and reports Recall@K against an exact scan.
//
// The exact scan runs in JavaScript and is the ground truth; it is also timed so
// the report shows both engines' latency on the same data.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_WASM = fileURLToPath(
  new URL("../../crates/vector-hnsw-wasm/target/wasm32-unknown-unknown/release/weisql_vector_hnsw_wasm.wasm", import.meta.url),
);
const ABI_VERSION = 3;
const METRIC_CODES = { cosine: 0, l2: 1, ip: 2 };

function parse(arguments_) {
  const options = {
    file: undefined,
    rows: 10_000,
    dimension: 32,
    metric: "l2",
    distribution: "clustered",
    queries: 50,
    topK: 10,
    m: 16,
    efConstruction: 200,
    efSearch: 64,
    wasm: DEFAULT_WASM,
    minRecall: undefined,
  };
  for (let index = 0; index < arguments_.length; index++) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    const take = () => { index++; return value; };
    if (flag === "--file") options.file = path.resolve(take());
    else if (flag === "--rows") options.rows = Number(take());
    else if (flag === "--dim") options.dimension = Number(take());
    else if (flag === "--metric") options.metric = take();
    else if (flag === "--distribution") options.distribution = take();
    else if (flag === "--queries") options.queries = Number(take());
    else if (flag === "--top-k") options.topK = Number(take());
    else if (flag === "--m") options.m = Number(take());
    else if (flag === "--ef-construction") options.efConstruction = Number(take());
    else if (flag === "--ef-search") options.efSearch = Number(take());
    else if (flag === "--wasm") options.wasm = path.resolve(take());
    else if (flag === "--min-recall") options.minRecall = Number(take());
    else throw new Error(`unknown option ${flag}`);
  }
  if (!(options.metric in METRIC_CODES)) throw new Error(`--metric must be one of ${Object.keys(METRIC_CODES).join(", ")}`);
  if (options.distribution !== "clustered" && options.distribution !== "random") {
    throw new Error("--distribution must be 'clustered' or 'random'");
  }
  if (options.minRecall !== undefined && (!Number.isFinite(options.minRecall) || options.minRecall < 0 || options.minRecall > 1)) {
    throw new Error("--min-recall must be between 0 and 1");
  }
  for (const [name, value] of [["rows", options.rows], ["dim", options.dimension], ["queries", options.queries], ["top-k", options.topK]]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} must be a positive safe integer`);
  }
  return options;
}

const options = parse(process.argv.slice(2));

async function loadVectors() {
  if (options.file === undefined) return synthetic(options.rows, options.dimension, options.distribution);
  const bytes = await readFile(options.file);
  const expected = options.rows * options.dimension * Float32Array.BYTES_PER_ELEMENT;
  if (bytes.byteLength !== expected) {
    throw new Error(`--file has ${bytes.byteLength} bytes, expected ${expected} for ${options.rows}×${options.dimension} f32`);
  }
  return new Float32Array(bytes.buffer, bytes.byteOffset, options.rows * options.dimension).slice();
}

function synthetic(rows, dimension, distribution) {
  let state = 7;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296 - 0.5;
  };
  const values = new Float32Array(rows * dimension);
  if (distribution === "random") {
    for (let index = 0; index < values.length; index++) values[index] = next();
    return values;
  }
  const clusters = 8;
  const centers = Array.from({ length: clusters }, () => Array.from({ length: dimension }, () => next() * 20));
  for (let row = 0; row < rows; row++) {
    const center = centers[Math.min(clusters - 1, Math.floor((next() + 0.5) * clusters))];
    for (let column = 0; column < dimension; column++) {
      values[row * dimension + column] = center[column] + next() * 0.5;
    }
  }
  return values;
}

function exactTopK(vectors, rows, dimension, query, k, metric) {
  let queryNorm = 0;
  if (metric === "cosine") for (let column = 0; column < dimension; column++) queryNorm += query[column] * query[column];
  const scored = new Array(rows);
  for (let row = 0; row < rows; row++) {
    const offset = row * dimension;
    let dot = 0;
    let norm = 0;
    let squared = 0;
    for (let column = 0; column < dimension; column++) {
      const a = query[column];
      const b = vectors[offset + column];
      dot += a * b;
      if (metric === "cosine") norm += b * b;
      if (metric === "l2") {
        const difference = a - b;
        squared += difference * difference;
      }
    }
    const distance = metric === "cosine"
      ? 1 - Math.max(-1, Math.min(1, dot / Math.sqrt(norm * queryNorm)))
      : metric === "l2"
        ? Math.sqrt(squared)
        : -dot;
    scored[row] = { row, distance };
  }
  scored.sort((left, right) => left.distance - right.distance || left.row - right.row);
  return scored.slice(0, Math.min(k, rows));
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

const vectors = await loadVectors();
const rows = options.rows;
const dimension = options.dimension;
const metricCode = METRIC_CODES[options.metric];

const wasmBytes = await readFile(options.wasm);
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const api = instance.exports;
if (api.weisql_hnsw_abi_version() !== ABI_VERSION) throw new Error(`unexpected HNSW WASM ABI ${api.weisql_hnsw_abi_version()}`);

const vectorBytes = vectors.byteLength;
const vectorPointer = api.weisql_hnsw_alloc(vectorBytes);
if (!vectorPointer) throw new Error("allocation failed for the vector buffer");
new Float32Array(api.memory.buffer, vectorPointer, vectors.length).set(vectors);
const buildStart = performance.now();
const built = api.weisql_hnsw_build(
  vectorPointer,
  rows,
  dimension,
  metricCode,
  options.m,
  options.efConstruction,
  options.efSearch,
  7,
  0,
);
const buildMs = performance.now() - buildStart;
api.weisql_hnsw_dealloc(vectorPointer, vectorBytes);
if (built !== 0) throw new Error(`HNSW build failed with code ${built}`);
if (api.weisql_hnsw_len() !== rows || api.weisql_hnsw_dimension() !== dimension) throw new Error("built graph does not match the input");
const indexBytes = api.weisql_hnsw_serialized_len();

const k = Math.min(options.topK, rows);
const queryBytes = dimension * Float32Array.BYTES_PER_ELEMENT;
const idBytes = k * Uint32Array.BYTES_PER_ELEMENT;
const distanceBytes = k * Float64Array.BYTES_PER_ELEMENT;
const queryPointer = api.weisql_hnsw_alloc(queryBytes);
const idPointer = api.weisql_hnsw_alloc(idBytes);
const distancePointer = api.weisql_hnsw_alloc(distanceBytes);
if (!queryPointer || !idPointer || !distancePointer) throw new Error("allocation failed for the query buffers");

const query = new Float32Array(dimension);
const hnswTimes = [];
const exactTimes = [];
let matched = 0;
let total = 0;
try {
  for (let sample = 0; sample < options.queries; sample++) {
    const row = Math.floor((sample * rows) / options.queries);
    query.set(vectors.subarray(row * dimension, (row + 1) * dimension));

    const exactStart = performance.now();
    const exact = exactTopK(vectors, rows, dimension, query, k, options.metric);
    exactTimes.push(performance.now() - exactStart);

    new Float32Array(api.memory.buffer, queryPointer, dimension).set(query);
    const hnswStart = performance.now();
    const found = api.weisql_hnsw_search(queryPointer, k, idPointer, distancePointer);
    hnswTimes.push(performance.now() - hnswStart);
    if (found < 0) throw new Error(`HNSW search failed with code ${found}`);

    const ids = new Uint32Array(api.memory.buffer, idPointer, found);
    const exactRows = new Set(exact.map(hit => hit.row));
    for (const id of ids) if (exactRows.has(id)) matched += 1;
    total += exact.length;
  }
} finally {
  api.weisql_hnsw_dealloc(queryPointer, queryBytes);
  api.weisql_hnsw_dealloc(idPointer, idBytes);
  api.weisql_hnsw_dealloc(distancePointer, distanceBytes);
}

hnswTimes.sort((left, right) => left - right);
exactTimes.sort((left, right) => left - right);
const recall = total === 0 ? 0 : matched / total;

console.log(`engine=weisql-hnsw-wasm`);
console.log(`source=${options.file ?? `synthetic-${options.distribution}`}`);
console.log(`rows=${rows}`);
console.log(`dimension=${dimension}`);
console.log(`metric=${options.metric}`);
console.log(`top_k=${k}`);
console.log(`queries=${options.queries}`);
console.log(`m=${options.m} ef_construction=${options.efConstruction} ef_search=${options.efSearch}`);
console.log(`build_ms=${buildMs.toFixed(1)}`);
console.log(`index_bytes=${indexBytes}`);
console.log(`hnsw_p50_ms=${percentile(hnswTimes, 0.5).toFixed(4)}`);
console.log(`hnsw_p95_ms=${percentile(hnswTimes, 0.95).toFixed(4)}`);
console.log(`exact_js_p50_ms=${percentile(exactTimes, 0.5).toFixed(4)}`);
console.log(`recall_at_k=${recall.toFixed(4)}`);
if (options.minRecall !== undefined && recall < options.minRecall) {
  console.error(`recall ${recall.toFixed(4)} is below --min-recall ${options.minRecall}`);
  process.exit(1);
}
