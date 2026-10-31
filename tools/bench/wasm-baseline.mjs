#!/usr/bin/env node
// Runs the WASM build of the Rust baseline against the same golden fixtures the
// TypeScript SDK and the native Rust tests use, so the browser artifact cannot
// drift from either side.
//
//   cargo build --release --target wasm32-unknown-unknown \
//     --manifest-path crates/vector-wasm/Cargo.toml
//   node tools/bench/wasm-baseline.mjs [path/to/weisql_vector_wasm.wasm]

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_WASM = new URL(
  "../../crates/vector-wasm/target/wasm32-unknown-unknown/release/weisql_vector_wasm.wasm",
  import.meta.url,
);
const FIXTURES = [
  new URL("../../crates/vector-benchmark/tests/fixtures/exact_cosine_golden.txt", import.meta.url),
  new URL("../../crates/vector-benchmark/tests/fixtures/metrics_golden.txt", import.meta.url),
];
const TOLERANCE = 1e-6;
const ABI_VERSION = 2;

const METRIC_CODES = new Map([
  ["cosine", 0],
  ["l2", 1],
  ["ip", 2],
]);

const ERROR_NAMES = new Map([
  [-1, "ERROR_ARGUMENT"],
  [-2, "ERROR_DATASET"],
  [-3, "ERROR_QUERY"],
  [-4, "ERROR_TOP_K"],
]);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseCases(text) {
  const cases = [];
  let current;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const [tag, ...rest] = line.split(/\s+/);
    if (tag === "case") {
      if (current !== undefined) cases.push(current);
      const [name, rows, dimension, topK] = rest;
      current = {
        name,
        metric: "cosine",
        rows: Number(rows),
        dimension: Number(dimension),
        topK: Number(topK),
        query: [],
        vectors: [],
        hits: [],
      };
      continue;
    }
    if (current === undefined) throw new Error(`record ${tag} before the first case`);
    switch (tag) {
      case "metric":
        current.metric = rest[0];
        break;
      case "query":
        current.query = rest.map(Number);
        break;
      case "v": {
        const [index, ...values] = rest;
        if (Number(index) !== current.vectors.length) {
          throw new Error(`case ${current.name}: vector rows must be contiguous`);
        }
        current.vectors.push(values.map(Number));
        break;
      }
      case "hit": {
        const [row, distance] = rest;
        current.hits.push({ row: Number(row), distance: Number(distance) });
        break;
      }
      default:
        throw new Error(`unknown record ${tag}`);
    }
  }
  if (current !== undefined) cases.push(current);
  return cases;
}

function runCase(api, testCase) {
  const values = testCase.vectors.flat();
  if (values.length !== testCase.rows * testCase.dimension) {
    throw new Error(`case ${testCase.name}: fixture row width does not match its header`);
  }
  const metricCode = METRIC_CODES.get(testCase.metric);
  if (metricCode === undefined) throw new Error(`case ${testCase.name}: unknown metric ${testCase.metric}`);

  const vectorBytes = values.length * Float32Array.BYTES_PER_ELEMENT;
  const queryBytes = testCase.dimension * Float32Array.BYTES_PER_ELEMENT;
  const idBytes = testCase.topK * Uint32Array.BYTES_PER_ELEMENT;
  const distanceBytes = testCase.topK * Float32Array.BYTES_PER_ELEMENT;

  const vectorPointer = api.weisql_alloc(vectorBytes);
  const queryPointer = api.weisql_alloc(queryBytes);
  const idPointer = api.weisql_alloc(idBytes);
  const distancePointer = api.weisql_alloc(distanceBytes);
  if (!vectorPointer || !queryPointer || !idPointer || !distancePointer) {
    throw new Error(`case ${testCase.name}: wasm allocation failed`);
  }

  try {
    // Views must be created only after every allocation: a growing memory
    // detaches earlier buffers.
    const input = api.memory.buffer;
    new Float32Array(input, vectorPointer, values.length).set(values);
    new Float32Array(input, queryPointer, testCase.dimension).set(testCase.query);

    const count = api.weisql_search_topk(
      vectorPointer,
      testCase.rows,
      testCase.dimension,
      queryPointer,
      testCase.topK,
      metricCode,
      idPointer,
      distancePointer,
    );
    if (count < 0) {
      throw new Error(`case ${testCase.name}: ${ERROR_NAMES.get(count) ?? count}`);
    }

    // Re-read the buffer: the search may have grown memory.
    const output = api.memory.buffer;
    const ids = new Uint32Array(output, idPointer, count).slice();
    const distances = new Float32Array(output, distancePointer, count).slice();

    if (count !== testCase.hits.length) {
      throw new Error(`case ${testCase.name}: expected ${testCase.hits.length} hits, got ${count}`);
    }
    for (let index = 0; index < count; index++) {
      const expected = testCase.hits[index];
      if (ids[index] !== expected.row) {
        throw new Error(`case ${testCase.name} position ${index}: row ${ids[index]} != ${expected.row}`);
      }
      if (Math.abs(distances[index] - expected.distance) > TOLERANCE) {
        throw new Error(
          `case ${testCase.name} position ${index}: ${distances[index]} != ${expected.distance}`,
        );
      }
    }
    return count;
  } finally {
    api.weisql_dealloc(vectorPointer, vectorBytes);
    api.weisql_dealloc(queryPointer, queryBytes);
    api.weisql_dealloc(idPointer, idBytes);
    api.weisql_dealloc(distancePointer, distanceBytes);
  }
}

const argument = process.argv[2];
const wasmUrl = argument === undefined ? DEFAULT_WASM : pathToFileURL(resolve(argument));

let bytes;
try {
  bytes = await readFile(wasmUrl);
} catch (error) {
  fail(
    `cannot read ${wasmUrl.pathname}: ${error.message}\n` +
      "build it with: cargo build --release --target wasm32-unknown-unknown --manifest-path crates/vector-wasm/Cargo.toml",
  );
}

const { instance } = await WebAssembly.instantiate(bytes, {});
const api = instance.exports;
if (!(api.memory instanceof WebAssembly.Memory)) fail("wasm module does not export its linear memory");
if (typeof api.weisql_abi_version !== "function") fail("wasm module is missing weisql_abi_version");
const abi = api.weisql_abi_version();
if (abi !== ABI_VERSION) fail(`wasm ABI version ${abi} != ${ABI_VERSION}`);

let cases = 0;
let hits = 0;
for (const fixture of FIXTURES) {
  for (const testCase of parseCases(await readFile(fixture, "utf8"))) {
    const count = runCase(api, testCase);
    console.log(`ok ${testCase.name} (${testCase.metric}): ${count} hits`);
    cases += 1;
    hits += count;
  }
}
console.log(`wasm golden parity: ${cases} cases, ${hits} hits, ABI v${abi}`);
