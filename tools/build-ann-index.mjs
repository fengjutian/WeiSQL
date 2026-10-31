/**
 * Builds a persisted ANN index for a package and records it in the Manifest.
 *
 *   node tools/build-ann-index.mjs <package-dir> [--engine usearch|hnsw]
 *        [--collection name]
 *        [--connectivity 16] [--expansion-add 128] [--expansion-search 512]
 *        [--m 16] [--ef-construction 200] [--ef-search 64] [--seed 1592614637]
 *        [--wasm path/to/weisql_vector_hnsw_wasm.wasm]
 *
 * One entry point for both ANN backends:
 * - `usearch` writes `indexes/<collection>.usearch` and records the USearch
 *   build parameters;
 * - `hnsw` runs the pure-Rust HNSW WASM module, writes
 *   `indexes/<collection>.hnsw` and records the graph parameters plus the
 *   serialized-format version.
 *
 * The Manifest gains an `index` entry, is re-validated before it is written,
 * and the caller should run `weisql validate <package-dir>` afterwards.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { Index } from "usearch";

import { NodeFileResourceReader, sha256Hex, validateManifest } from "@weisql/sdk";

const require = createRequire(import.meta.url);

/** `usearch/package.json` is not exported, so walk up from the resolved entry. */
function packageVersion(name) {
  let directory = path.dirname(require.resolve(name));
  for (let depth = 0; depth < 6; depth++) {
    try {
      const manifest = JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
      if (manifest.name === name) return manifest.version;
    } catch {
      // keep walking
    }
    directory = path.dirname(directory);
  }
  return "unknown";
}

const METRIC = { cosine: "cos", l2: "l2sq", ip: "ip" };
const METRIC_CODE = { cosine: 0, l2: 1, ip: 2 };
const HNSW_ABI_VERSION = 3;
const HNSW_INDEX_ENGINE = "weisql-hnsw";
const HNSW_INDEX_VERSION = "1";
const DEFAULT_HNSW_WASM = new URL(
  "../crates/vector-hnsw-wasm/target/wasm32-unknown-unknown/release/weisql_vector_hnsw_wasm.wasm",
  import.meta.url,
);

function parse(arguments_) {
  const options = {
    directory: undefined,
    engine: "usearch",
    collection: undefined,
    connectivity: 16,
    expansionAdd: 128,
    expansionSearch: 512,
    m: 16,
    efConstruction: 200,
    efSearch: 64,
    seed: 0x5eed5eed,
    wasm: undefined,
    recallSamples: 0,
    recallTopK: 10,
    minRecall: undefined,
  };
  for (let index = 0; index < arguments_.length; index++) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === "--engine") { options.engine = value; index++; }
    else if (flag === "--collection") { options.collection = value; index++; }
    else if (flag === "--connectivity") { options.connectivity = Number(value); index++; }
    else if (flag === "--expansion-add") { options.expansionAdd = Number(value); index++; }
    else if (flag === "--expansion-search") { options.expansionSearch = Number(value); index++; }
    else if (flag === "--m") { options.m = Number(value); index++; }
    else if (flag === "--ef-construction") { options.efConstruction = Number(value); index++; }
    else if (flag === "--ef-search") { options.efSearch = Number(value); index++; }
    else if (flag === "--seed") { options.seed = Number(value); index++; }
    else if (flag === "--wasm") { options.wasm = value; index++; }
    else if (flag === "--recall-samples") { options.recallSamples = Number(value); index++; }
    else if (flag === "--recall-top-k") { options.recallTopK = Number(value); index++; }
    else if (flag === "--min-recall") { options.minRecall = Number(value); index++; }
    else if (flag.startsWith("--")) throw new Error(`unknown option ${flag}`);
    else if (options.directory === undefined) options.directory = flag;
    else throw new Error(`unexpected argument ${flag}`);
  }
  if (options.directory === undefined) {
    throw new Error("usage: node tools/build-ann-index.mjs <package-dir> [--engine usearch|hnsw]");
  }
  if (options.engine !== "usearch" && options.engine !== "hnsw") {
    throw new Error("--engine must be 'usearch' or 'hnsw'");
  }
  for (const [name, value] of [
    ["connectivity", options.connectivity],
    ["expansion-add", options.expansionAdd],
    ["expansion-search", options.expansionSearch],
    ["m", options.m],
    ["ef-construction", options.efConstruction],
    ["ef-search", options.efSearch],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(options.seed) || options.seed < 0) throw new Error("seed must be a non-negative safe integer");
  if (!Number.isSafeInteger(options.recallSamples) || options.recallSamples < 0) {
    throw new Error("recall-samples must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(options.recallTopK) || options.recallTopK <= 0) {
    throw new Error("recall-top-k must be a positive safe integer");
  }
  if (options.recallSamples > 0 && options.engine !== "hnsw") {
    throw new Error("--recall-samples is only supported for --engine hnsw");
  }
  if (options.minRecall !== undefined && (!Number.isFinite(options.minRecall) || options.minRecall < 0 || options.minRecall > 1)) {
    throw new Error("--min-recall must be between 0 and 1");
  }
  if (options.minRecall !== undefined && options.recallSamples === 0) {
    throw new Error("--min-recall requires --recall-samples");
  }
  return options;
}

async function readAllVectors(reader, collection) {
  const values = new Float32Array(collection.count * collection.dimension);
  const rowBytes = collection.dimension * 4;
  const batchRows = 4096;
  for (let startRow = 0; startRow < collection.count; startRow += batchRows) {
    const rows = Math.min(batchRows, collection.count - startRow);
    const bytes = await reader.readRange(collection.data.path, {
      start: startRow * rowBytes,
      end: (startRow + rows) * rowBytes,
    });
    if (bytes.byteLength !== rows * rowBytes) throw new Error("vector block length mismatch while building the index");
    values.set(new Float32Array(bytes.buffer, bytes.byteOffset, rows * collection.dimension), startRow * collection.dimension);
  }
  return values;
}

/**
 * Exact Top-K scan over the materialised vectors. Used only for the optional
 * recall report, never to build the index.
 */
function exactTopK(vectors, count, dimension, query, k, metric) {
  let queryNorm = 0;
  if (metric === "cosine") {
    for (let column = 0; column < dimension; column++) queryNorm += query[column] * query[column];
  }
  const scored = new Array(count);
  for (let row = 0; row < count; row++) {
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
  return scored.slice(0, Math.min(k, count));
}

/** Recall@K of the built graph against an exact scan on deterministic samples. */
function measureRecall(api, vectors, collection, samples, topK) {
  const dimension = collection.dimension;
  const k = Math.min(topK, collection.count);
  const queryBytes = dimension * Float32Array.BYTES_PER_ELEMENT;
  const idBytes = k * Uint32Array.BYTES_PER_ELEMENT;
  const distanceBytes = k * Float64Array.BYTES_PER_ELEMENT;
  const queryPointer = api.weisql_hnsw_alloc(queryBytes);
  const idPointer = api.weisql_hnsw_alloc(idBytes);
  const distancePointer = api.weisql_hnsw_alloc(distanceBytes);
  if (!queryPointer || !idPointer || !distancePointer) {
    throw new Error("recall sampling could not allocate WASM buffers");
  }
  const query = new Float32Array(dimension);
  let matched = 0;
  let total = 0;
  try {
    for (let sample = 0; sample < samples; sample++) {
      const row = Math.floor((sample * collection.count) / samples);
      query.set(vectors.subarray(row * dimension, (row + 1) * dimension));
      new Float32Array(api.memory.buffer, queryPointer, dimension).set(query);
      const found = api.weisql_hnsw_search(queryPointer, k, idPointer, distancePointer);
      if (found < 0) throw new Error(`recall sampling search failed with code ${found}`);
      const ids = new Uint32Array(api.memory.buffer, idPointer, found);
      const exact = exactTopK(vectors, collection.count, dimension, query, k, collection.metric);
      const exactRows = new Set(exact.map(hit => hit.row));
      for (const id of ids) {
        if (exactRows.has(id)) matched += 1;
      }
      total += exact.length;
    }
  } finally {
    api.weisql_hnsw_dealloc(queryPointer, queryBytes);
    api.weisql_hnsw_dealloc(idPointer, idBytes);
    api.weisql_hnsw_dealloc(distancePointer, distanceBytes);
  }
  return { samples, topK: k, recallAtK: total === 0 ? 1 : matched / total };
}

async function buildUsearch(reader, collection, options) {  const index = new Index({
    metric: METRIC[collection.metric],
    dimensions: collection.dimension,
    quantization: "f32",
    connectivity: options.connectivity,
    expansion_add: options.expansionAdd,
    expansion_search: options.expansionSearch,
    multi: false,
  });
  const rowBytes = collection.dimension * 4;
  const batchRows = 4096;
  for (let startRow = 0; startRow < collection.count; startRow += batchRows) {
    const rows = Math.min(batchRows, collection.count - startRow);
    const bytes = await reader.readRange(collection.data.path, {
      start: startRow * rowBytes,
      end: (startRow + rows) * rowBytes,
    });
    if (bytes.byteLength !== rows * rowBytes) throw new Error("vector block length mismatch while building the index");
    const vectors = new Float32Array(bytes.buffer, bytes.byteOffset, rows * collection.dimension);
    const keys = new BigUint64Array(rows);
    for (let row = 0; row < rows; row++) keys[row] = BigInt(startRow + row);
    index.add(keys, vectors);
  }

  const staging = await mkdtemp(path.join(tmpdir(), "weisql-ann-index-"));
  const stagedFile = path.join(staging, "index.bin");
  try {
    index.save(stagedFile);
    return new Uint8Array(await readFile(stagedFile));
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function buildHnsw(reader, collection, options) {
  const wasmPath = options.wasm === undefined ? DEFAULT_HNSW_WASM : path.resolve(options.wasm);
  let moduleBytes;
  try {
    moduleBytes = await readFile(wasmPath);
  } catch (cause) {
    throw new Error(
      `HNSW WASM module not found at ${wasmPath}; run \`npm run build:hnsw-wasm\` or pass --wasm`,
      { cause },
    );
  }
  const { instance } = await WebAssembly.instantiate(moduleBytes, {});
  const api = instance.exports;
  if (typeof api.weisql_hnsw_abi_version !== "function" || api.weisql_hnsw_abi_version() !== HNSW_ABI_VERSION) {
    throw new Error(`HNSW WASM ABI mismatch: expected ${HNSW_ABI_VERSION}`);
  }

  const vectors = await readAllVectors(reader, collection);
  const vectorBytes = vectors.byteLength;
  const vectorPointer = api.weisql_hnsw_alloc(vectorBytes);
  if (!vectorPointer) throw new Error(`HNSW WASM allocation failed for ${vectorBytes} vector bytes`);
  let serializedPointer = 0;
  let serializedBytes = 0;
  try {
    new Uint8Array(api.memory.buffer, vectorPointer, vectorBytes).set(new Uint8Array(vectors.buffer));
    const seed = BigInt(options.seed);
    const code = api.weisql_hnsw_build(
      vectorPointer,
      collection.count,
      collection.dimension,
      METRIC_CODE[collection.metric],
      options.m,
      options.efConstruction,
      options.efSearch,
      Number(seed & 0xffffffffn),
      Number(seed >> 32n),
    );
    if (code !== 0) throw new Error(`HNSW build rejected the vectors (code ${code})`);

    serializedBytes = api.weisql_hnsw_serialized_len();
    if (!Number.isSafeInteger(serializedBytes) || serializedBytes <= 0) {
      throw new Error("HNSW serialized length is invalid");
    }
    serializedPointer = api.weisql_hnsw_alloc(serializedBytes);
    if (!serializedPointer) throw new Error(`HNSW WASM allocation failed for ${serializedBytes} index bytes`);
    const written = api.weisql_hnsw_save(serializedPointer, serializedBytes);
    if (written !== serializedBytes) throw new Error(`HNSW save wrote ${written} of ${serializedBytes} bytes`);
    const recall = options.recallSamples > 0
      ? measureRecall(api, vectors, collection, options.recallSamples, options.recallTopK)
      : undefined;
    if (recall !== undefined && options.minRecall !== undefined && recall.recallAtK < options.minRecall) {
      throw new Error(
        `recall@${recall.topK} is ${recall.recallAtK.toFixed(3)}, below --min-recall ${options.minRecall}`,
      );
    }
    return { bytes: new Uint8Array(api.memory.buffer, serializedPointer, serializedBytes).slice(), recall };
  } finally {
    if (serializedPointer) api.weisql_hnsw_dealloc(serializedPointer, serializedBytes);
    api.weisql_hnsw_dealloc(vectorPointer, vectorBytes);
  }
}

const options = parse(process.argv.slice(2));
const directory = path.resolve(options.directory);

const manifestPath = path.join(directory, "manifest.json");
const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
const collection = options.collection === undefined
  ? manifest.vectorCollections[0]
  : manifest.vectorCollections.find(item => item.name === options.collection);
if (collection === undefined) throw new Error(`collection not found: ${options.collection}`);
if (collection.index !== undefined) throw new Error(`collection already declares an index: ${collection.name}`);

const reader = new NodeFileResourceReader({ rootDirectory: directory });
const started = performance.now();
let indexBytes;
let descriptor;
let recall;
try {
  if (options.engine === "usearch") {
    indexBytes = await buildUsearch(reader, collection, options);
    descriptor = {
      engine: "usearch",
      version: packageVersion("usearch"),
      params: {
        connectivity: options.connectivity,
        expansion_add: options.expansionAdd,
        expansion_search: options.expansionSearch,
      },
    };
  } else {
    const built = await buildHnsw(reader, collection, options);
    indexBytes = built.bytes;
    recall = built.recall;
    descriptor = {
      engine: HNSW_INDEX_ENGINE,
      version: HNSW_INDEX_VERSION,
      params: {
        m: options.m,
        ef_construction: options.efConstruction,
        ef_search: options.efSearch,
        seed: options.seed,
      },
    };
  }
} finally {
  await reader.close();
}

const extension = options.engine === "usearch" ? "usearch" : "hnsw";
const relativePath = `indexes/${collection.name}.${extension}`;
await mkdir(path.join(directory, "indexes"), { recursive: true });
await writeFile(path.join(directory, ...relativePath.split("/")), indexBytes);

collection.index = {
  ...descriptor,
  file: { path: relativePath, bytes: indexBytes.byteLength, sha256: sha256Hex(indexBytes) },
};

// Re-validate before writing: an invalid Manifest must never reach disk.
validateManifest(manifest);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  package: directory,
  collection: collection.name,
  engine: collection.index.engine,
  version: collection.index.version,
  vectors: collection.count,
  dimensions: collection.dimension,
  indexBytes: indexBytes.byteLength,
  bytesPerVector: Math.round(indexBytes.byteLength / Math.max(1, collection.count)),
  buildMs: Math.round(performance.now() - started),
  params: collection.index.params,
  ...(recall === undefined ? {} : { recall }),
  next: `weisql validate ${path.relative(process.cwd(), directory) || "."}`,
}, null, 2));
