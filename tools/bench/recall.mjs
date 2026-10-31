#!/usr/bin/env node
/**
 * Measures Recall@K of the USearch ANN path on real embeddings.
 *
 * Input is a NumPy `.npy` float32 matrix (or raw row-major `.f32` with
 * `--dimension`). Queries are sampled rows; exact cosine search over the same
 * vectors is the ground truth, and self-matches are excluded by default.
 *
 * This makes no claim until someone runs it on real data: the tool only makes
 * that run reproducible.
 */
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Index, MetricKind, ScalarKind } from "usearch";

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(2);
}

function parseArguments(argv) {
  const options = {
    embeddings: undefined,
    dimension: undefined,
    queries: 200,
    topK: 10,
    connectivity: 16,
    expansion: 128,
    excludeSelf: true,
    seed: 7,
    selfTest: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const next = () => {
      const value = argv[++index];
      if (value === undefined) throw new Error(`${argument} requires a value`);
      return value;
    };
    switch (argument) {
      case "--embeddings": options.embeddings = next(); break;
      case "--dimension": options.dimension = Number(next()); break;
      case "--queries": options.queries = Number(next()); break;
      case "--top-k": options.topK = Number(next()); break;
      case "--connectivity": options.connectivity = Number(next()); break;
      case "--expansion": options.expansion = Number(next()); break;
      case "--include-self": options.excludeSelf = false; break;
      case "--seed": options.seed = Number(next()); break;
      case "--self-test": options.selfTest = true; break;
      default: throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

/** Parses a 2-D float32 `.npy` file (C order). */
function parseNpy(buffer) {
  if (buffer.length < 10 || buffer.toString("latin1", 0, 6) !== "\u0093NUMPY") throw new Error("not a .npy file");
  const major = buffer[6];
  const headerLength = major === 1 ? buffer.readUInt16LE(8) : buffer.readUInt32LE(8);
  const headerStart = major === 1 ? 10 : 12;
  const header = buffer.toString("latin1", headerStart, headerStart + headerLength);
  if (!/'descr':\s*'<f4'/.test(header)) throw new Error(`unsupported dtype; expected '<f4' in ${header}`);
  if (!/'fortran_order':\s*False/.test(header)) throw new Error("fortran-order arrays are not supported");
  const shape = /'shape':\s*\((\d+),\s*(\d+)\)/.exec(header);
  if (shape === null) throw new Error(`unsupported shape in ${header}`);
  const rows = Number(shape[1]);
  const dimension = Number(shape[2]);
  const dataStart = headerStart + headerLength;
  const expected = rows * dimension * 4;
  if (buffer.length - dataStart < expected) throw new Error("file is shorter than its declared shape");
  const vectors = new Float32Array(buffer.buffer, buffer.byteOffset + dataStart, rows * dimension);
  return { vectors, rows, dimension };
}

/** Writes a tiny `.npy` so `--self-test` exercises the real parser. */
function encodeNpy(rows, dimension, values) {
  const magic = Buffer.from([0x93, 0x4e, 0x55, 0x4d, 0x50, 0x59, 1, 0]);
  let header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${rows}, ${dimension}), }`;
  const total = 10 + header.length + 1;
  header += " ".repeat((64 - (total % 64)) % 64) + "\n";
  const headerBuffer = Buffer.from(header, "latin1");
  const length = Buffer.alloc(2);
  length.writeUInt16LE(headerBuffer.length, 0);
  const data = Buffer.from(values.buffer, values.byteOffset, values.byteLength);
  return Buffer.concat([magic, length, headerBuffer, data]);
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

function cosine(a, aOffset, b, bOffset, dimension) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let column = 0; column < dimension; column++) {
    const left = a[aOffset + column];
    const right = b[bOffset + column];
    dot += left * right;
    normA += left * left;
    normB += right * right;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

/** Exact top-K excluding the query itself, matching ANN recall practice. */
function exactTopK(vectors, rows, dimension, queryRow, topK, excludeSelf) {
  const best = [];
  for (let row = 0; row < rows; row++) {
    if (excludeSelf && row === queryRow) continue;
    const score = cosine(vectors, row * dimension, vectors, queryRow * dimension, dimension);
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
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

async function measure(vectors, rows, dimension, options) {
  const random = mulberry32(options.seed);
  const queryRows = [];
  for (let index = 0; index < Math.min(options.queries, rows); index++) {
    let candidate = Math.floor(random() * rows);
    while (queryRows.includes(candidate)) candidate = Math.floor(random() * rows);
    queryRows.push(candidate);
  }

  console.log(`computing exact ground truth for ${queryRows.length} queries…`);
  const truth = queryRows.map(row => exactTopK(vectors, rows, dimension, row, options.topK, options.excludeSelf));

  const index = new Index({
    dimensions: dimension,
    metric: MetricKind.Cos,
    quantization: ScalarKind.F32,
    connectivity: options.connectivity,
    expansion_search: options.expansion,
  });
  const keys = new BigUint64Array(rows);
  for (let row = 0; row < rows; row++) keys[row] = BigInt(row);
  const buildStarted = performance.now();
  index.add(keys, vectors, rows);
  const buildMs = performance.now() - buildStarted;

  const latencies = [];
  let hits = 0;
  for (const [offset, row] of queryRows.entries()) {
    const query = vectors.subarray(row * dimension, (row + 1) * dimension);
    const started = performance.now();
    const matches = index.search(query, options.topK + (options.excludeSelf ? 1 : 0));
    latencies.push(performance.now() - started);
    const found = new Set(Array.from(matches.keys, key => Number(key)));
    found.delete(row);
    for (const truthRow of truth[offset]) if (found.has(truthRow)) hits++;
  }
  latencies.sort((left, right) => left - right);

  const directory = await mkdtemp(path.join(tmpdir(), "weisql-recall-"));
  let indexBytes;
  try {
    const file = path.join(directory, "index.usearch");
    index.save(file);
    indexBytes = (await stat(file)).size;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  return {
    rows,
    dimension,
    queries: queryRows.length,
    topK: options.topK,
    connectivity: options.connectivity,
    expansionSearch: options.expansion,
    excludeSelf: options.excludeSelf,
    recall: Number((hits / (queryRows.length * options.topK)).toFixed(4)),
    p50Ms: Number(percentile(latencies, 0.5).toFixed(3)),
    p95Ms: Number(percentile(latencies, 0.95).toFixed(3)),
    buildMs: Math.round(buildMs),
    indexBytes,
  };
}

const options = parseArguments(process.argv.slice(2));

if (options.selfTest) {
  const rows = 256;
  const dimension = 16;
  const random = mulberry32(11);
  const values = new Float32Array(rows * dimension);
  for (let index = 0; index < values.length; index++) values[index] = random() * 2 - 1;
  const buffer = encodeNpy(rows, dimension, values);
  const parsed = parseNpy(buffer);
  const result = await measure(parsed.vectors, parsed.rows, parsed.dimension, { ...options, queries: 20, topK: 5 });
  console.log(JSON.stringify(result, null, 2));
  if (result.recall < 0.95) fail(`self-test recall too low: ${result.recall}`);
  console.log("self-test passed");
  process.exit(0);
}

if (options.embeddings === undefined) fail("provide --embeddings <file.npy|file.f32>");

let parsed;
if (options.embeddings.endsWith(".npy")) {
  parsed = parseNpy(await readFile(options.embeddings));
} else {
  const dimension = options.dimension;
  if (!Number.isSafeInteger(dimension) || dimension <= 0) fail("raw .f32 input needs --dimension");
  const buffer = await readFile(options.embeddings);
  const rows = buffer.byteLength / (dimension * 4);
  if (!Number.isInteger(rows)) fail(`file size is not a multiple of dimension × 4`);
  parsed = { vectors: new Float32Array(buffer.buffer, buffer.byteOffset, rows * dimension), rows, dimension };
  console.log(JSON.stringify({ source: options.embeddings, rows, dimension }));
}

const result = await measure(parsed.vectors, parsed.rows, parsed.dimension, options);
console.log("");
console.log("rows      dimension  queries  recall@K  p50 ms  p95 ms  build ms  index MB");
console.log(
  `${String(result.rows).padEnd(9)} ${String(result.dimension).padEnd(10)} ${String(result.queries).padEnd(8)} ` +
  `${String(result.recall).padEnd(9)} ${String(result.p50Ms).padEnd(7)} ${String(result.p95Ms).padEnd(7)} ` +
  `${String(result.buildMs).padEnd(9)} ${(result.indexBytes / 1024 / 1024).toFixed(2)}`,
);
console.log("");
console.log(JSON.stringify(result, null, 2));
