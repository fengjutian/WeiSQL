#!/usr/bin/env node
/**
 * Measures the recall/size tradeoff of USearch quantization on synthetic vectors.
 *
 * This changes no package format and makes no real-embedding claim: it answers
 * "what does i8/f16 cost in recall and save in index size" for the same data,
 * using exact search as ground truth.
 */
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Index, MetricKind, ScalarKind } from "usearch";

const QUANTIZATIONS = {
  f32: ScalarKind.F32,
  f16: ScalarKind.F16,
  i8: ScalarKind.I8,
};

function parseArguments(argv) {
  const options = { rows: 20_000, dimension: 64, queries: 20, topK: 10, clusters: 0, seed: 7, connectivity: 16, expansion: 128, quantizations: ["f32", "f16", "i8"], selfTest: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      return value;
    };
    switch (argument) {
      case "--rows": options.rows = Number(next()); break;
      case "--dimension": options.dimension = Number(next()); break;
      case "--queries": options.queries = Number(next()); break;
      case "--top-k": options.topK = Number(next()); break;
      case "--clusters": options.clusters = Number(next()); break;
      case "--seed": options.seed = Number(next()); break;
      case "--connectivity": options.connectivity = Number(next()); break;
      case "--expansion": options.expansion = Number(next()); break;
      case "--quantizations": options.quantizations = next().split(",").map(item => item.trim()).filter(Boolean); break;
      case "--self-test": options.selfTest = true; break;
      default: throw new Error(`unknown argument: ${argument}`);
    }
  }
  for (const name of options.quantizations) {
    if (QUANTIZATIONS[name] === undefined) throw new Error(`unknown quantization '${name}' (use f32, f16 or i8)`);
  }
  return options;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random) {
  // Box-Muller; avoids a dependency on any stats package.
  const u = Math.max(random(), Number.EPSILON);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function generate(options) {
  const random = mulberry32(options.seed);
  const { rows, dimension, clusters } = options;
  const centroids = clusters > 0
    ? Array.from({ length: clusters }, () => Float32Array.from({ length: dimension }, () => gaussian(random)))
    : undefined;
  const vectors = new Float32Array(rows * dimension);
  for (let row = 0; row < rows; row++) {
    const centroid = centroids?.[Math.floor(random() * clusters)];
    for (let column = 0; column < dimension; column++) {
      const base = centroid?.[column] ?? 0;
      vectors[row * dimension + column] = base + gaussian(random);
    }
  }
  // Queries reuse existing rows perturbed slightly, so ground truth is not degenerate.
  const queries = [];
  for (let query = 0; query < options.queries; query++) {
    const source = Math.floor(random() * rows) * dimension;
    const vector = new Float32Array(dimension);
    for (let column = 0; column < dimension; column++) vector[column] = vectors[source + column] + gaussian(random) * 0.05;
    queries.push(vector);
  }
  return { vectors, queries };
}

function cosineSimilarity(a, aOffset, b, dimension) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let column = 0; column < dimension; column++) {
    const left = a[aOffset + column];
    const right = b[column];
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

/** Exact top-K by cosine similarity, used as the ground truth for recall. */
function exactTopK(vectors, rows, dimension, query, topK) {
  const best = [];
  for (let row = 0; row < rows; row++) {
    const score = cosineSimilarity(vectors, row * dimension, query, dimension);
    if (best.length < topK) {
      best.push({ row, score });
      best.sort((left, right) => right.score - left.score);
    } else if (score > best[best.length - 1].score) {
      best[best.length - 1] = { row, score };
      best.sort((left, right) => right.score - left.score);
    }
  }
  return best.map(item => item.row);
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

const options = parseArguments(process.argv.slice(2));
const directory = await mkdtemp(path.join(tmpdir(), "weisql-quant-"));

if (options.selfTest) {
  const rows = 512;
  const dimension = 16;
  const random = mulberry32(3);
  const vectors = new Float32Array(rows * dimension);
  for (let index = 0; index < vectors.length; index++) vectors[index] = random() * 2 - 1;
  const query = vectors.subarray(0, dimension);
  const sizes = {};

  for (const name of options.quantizations) {
    const index = new Index({
      dimensions: dimension,
      metric: MetricKind.Cos,
      quantization: QUANTIZATIONS[name],
      connectivity: 16,
      expansion_search: 64,
    });
    const keys = new BigUint64Array(rows);
    for (let row = 0; row < rows; row++) keys[row] = BigInt(row);
    index.add(keys, vectors);
    const matches = index.search(query, 5);
    if (matches.keys.length !== 5) throw new Error(`${name}: expected 5 matches, got ${matches.keys.length}`);
    const file = path.join(directory, `${name}.self-test.usearch`);
    index.save(file);
    sizes[name] = (await stat(file)).size;
  }

  // Quantization exists to save space; if this ordering breaks, the benchmark is
  // measuring something else.
  if (!(sizes.f32 > sizes.f16 && sizes.f16 > sizes.i8)) {
    throw new Error(`quantization size ordering is wrong: ${JSON.stringify(sizes)}`);
  }
  console.log(JSON.stringify(sizes));
  console.log("quantization self-test passed");
  await rm(directory, { recursive: true, force: true });
  process.exit(0);
}
const generateStarted = performance.now();
const { vectors, queries } = generate(options);
const generateMs = Math.round(performance.now() - generateStarted);

console.log(JSON.stringify({ rows: options.rows, dimension: options.dimension, clusters: options.clusters, queries: options.queries, topK: options.topK }));
console.log("building exact ground truth…");
const truthStarted = performance.now();
const truth = queries.map(query => exactTopK(vectors, options.rows, options.dimension, query, options.topK));
const truthMs = Math.round(performance.now() - truthStarted);

const results = [];
try {
  for (const name of options.quantizations) {
    const index = new Index({
      dimensions: options.dimension,
      metric: MetricKind.Cos,
      quantization: QUANTIZATIONS[name],
      connectivity: options.connectivity,
      expansion_search: options.expansion,
    });
    const keys = new BigUint64Array(options.rows);
    for (let row = 0; row < options.rows; row++) keys[row] = BigInt(row);

    const buildStarted = performance.now();
    index.add(keys, vectors);
    const buildMs = performance.now() - buildStarted;

    const latencies = [];
    let hits = 0;
    for (const [offset, query] of queries.entries()) {
      const started = performance.now();
      const matches = index.search(query, options.topK);
      latencies.push(performance.now() - started);
      const found = new Set(Array.from(matches.keys, key => Number(key)));
      for (const row of truth[offset]) if (found.has(row)) hits++;
    }
    latencies.sort((left, right) => left - right);

    const file = path.join(directory, `${name}.usearch`);
    index.save(file);
    const size = (await stat(file)).size;

    results.push({
      quantization: name,
      recall: Number((hits / (options.queries * options.topK)).toFixed(3)),
      p50Ms: Number(percentile(latencies, 0.5).toFixed(2)),
      buildMs: Math.round(buildMs),
      indexBytes: size,
      searchExpansion: options.expansion,
    });
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

console.log("");
console.log("quantization  recall@K  p50 ms  build ms  index MB");
for (const row of results) {
  console.log(`${row.quantization.padEnd(12)}  ${String(row.recall).padEnd(8)}  ${String(row.p50Ms).padEnd(6)}  ${String(row.buildMs).padEnd(8)}  ${(row.indexBytes / 1024 / 1024).toFixed(2)}`);
}
console.log("");
console.log(JSON.stringify({ generateMs, truthMs, results, caveat: "synthetic vectors; real-embedding benefit is not measured" }, null, 2));
