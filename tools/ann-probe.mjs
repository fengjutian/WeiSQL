/**
 * ANN feasibility probe for USearch (REQ-303).
 *
 *   npm i --no-save usearch
 *   COUNT=100000 DIMS=128 QUERIES=10 EXPANSION_SEARCH=512 node tools/ann-probe.mjs
 *
 * Measures build time, search latency, Recall@K against brute force, and the
 * index save/load round trip. It deliberately does not touch the SDK: this
 * answers "can we use it, and what does it cost", not "how do we wire it".
 */
import { statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const DIMENSIONS = Number(process.env.DIMS ?? 128);
const COUNT = Number(process.env.COUNT ?? 100_000);
const QUERIES = Number(process.env.QUERIES ?? 10);
const TOP_K = Number(process.env.TOP_K ?? 10);
const RECALL_QUERIES = Math.min(Number(process.env.RECALL ?? 3), QUERIES);
const EXPANSION_SEARCH = Number(process.env.EXPANSION_SEARCH ?? 64);
const CONNECTIVITY = Number(process.env.CONNECTIVITY ?? 16);
const EXPANSION_ADD = Number(process.env.EXPANSION_ADD ?? 128);
const INDEX_FILE = path.join(os.tmpdir(), `weisql-usearch-${COUNT}x${DIMENSIONS}.index`);

let Index;
try {
  ({ Index } = await import("usearch"));
} catch {
  console.error("usearch is not installed. Run: npm i --no-save usearch");
  process.exit(2);
}

function makeVectors(count, dimensions, seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  const vectors = new Float32Array(count * dimensions);
  for (let i = 0; i < vectors.length; i++) vectors[i] = next() * 2 - 1;
  return vectors;
}

function percentile(sorted, fraction) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

const vectors = makeVectors(COUNT, DIMENSIONS, 7);
const keys = new BigUint64Array(COUNT);
for (let i = 0; i < COUNT; i++) keys[i] = BigInt(i);

const config = { metric: "cos", dimensions: DIMENSIONS, connectivity: CONNECTIVITY, expansion_add: EXPANSION_ADD, expansion_search: EXPANSION_SEARCH };
const index = new Index(config);

const buildStarted = performance.now();
const BATCH = 4096;
for (let start = 0; start < COUNT; start += BATCH) {
  const rows = Math.min(BATCH, COUNT - start);
  index.add(keys.subarray(start, start + rows), vectors.subarray(start * DIMENSIONS, (start + rows) * DIMENSIONS));
}
const buildMs = performance.now() - buildStarted;

const queryVectors = makeVectors(QUERIES, DIMENSIONS, 99);
const latencies = [];
const annResults = [];
for (let i = 0; i < QUERIES; i++) {
  const query = queryVectors.subarray(i * DIMENSIONS, (i + 1) * DIMENSIONS);
  const started = performance.now();
  const matches = index.search(query, TOP_K);
  latencies.push(performance.now() - started);
  annResults.push(Array.from(matches.keys, (key) => Number(key)));
}

const sorted = [...latencies].sort((left, right) => left - right);

let overlap = 0;
for (let i = 0; i < RECALL_QUERIES; i++) {
  const query = queryVectors.subarray(i * DIMENSIONS, (i + 1) * DIMENSIONS);
  let queryNorm = 0;
  for (let d = 0; d < DIMENSIONS; d++) queryNorm += query[d] * query[d];
  queryNorm = Math.sqrt(queryNorm);
  const scored = new Array(COUNT);
  for (let row = 0; row < COUNT; row++) {
    let dot = 0;
    let norm = 0;
    const base = row * DIMENSIONS;
    for (let d = 0; d < DIMENSIONS; d++) {
      const value = vectors[base + d];
      dot += value * query[d];
      norm += value * value;
    }
    scored[row] = { row, distance: 1 - dot / (Math.sqrt(norm) * queryNorm) };
  }
  scored.sort((left, right) => left.distance - right.distance || left.row - right.row);
  const truth = new Set(scored.slice(0, TOP_K).map((entry) => entry.row));
  overlap += annResults[i].filter((row) => truth.has(row)).length;
}

const saveStarted = performance.now();
index.save(INDEX_FILE);
const saveMs = performance.now() - saveStarted;
const indexBytes = statSync(INDEX_FILE).size;

const restoreStarted = performance.now();
const restored = new Index(config);
restored.load(INDEX_FILE);
const restoreMs = performance.now() - restoreStarted;
const restoredMatches = restored.search(queryVectors.subarray(0, DIMENSIONS), TOP_K);

console.log(JSON.stringify({
  dataset: { count: COUNT, dimensions: DIMENSIONS, distribution: "uniform[-1,1]", seed: 7 },
  params: { metric: "cos", connectivity: CONNECTIVITY, expansionAdd: EXPANSION_ADD, expansionSearch: EXPANSION_SEARCH },
  build: { buildMs: Number(buildMs.toFixed(0)), capacity: index.capacity() },
  search: {
    queries: QUERIES,
    topK: TOP_K,
    p50Ms: Number(percentile(sorted, 0.5).toFixed(3)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(3)),
    minMs: Number(sorted[0].toFixed(3)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(3)),
    recallQueries: RECALL_QUERIES,
    recallAtK: Number((overlap / (RECALL_QUERIES * TOP_K)).toFixed(4)),
  },
  persistence: {
    file: INDEX_FILE,
    bytes: indexBytes,
    bytesPerVector: Math.round(indexBytes / COUNT),
    saveMs: Number(saveMs.toFixed(0)),
    restoreMs: Number(restoreMs.toFixed(0)),
    restoredSize: restored.size(),
    sameTop1: Number(restoredMatches.keys[0]) === annResults[0][0],
  },
  host: { cpu: os.cpus()[0]?.model ?? "unknown", cores: os.cpus().length, node: process.version },
}, null, 2));
