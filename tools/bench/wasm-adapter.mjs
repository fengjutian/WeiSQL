#!/usr/bin/env node
// End-to-end check for the WASM vector adapter: the same requests must produce
// the same rows, business ids and distances as the TypeScript exact adapter.
//
//   cargo build --release --target wasm32-unknown-unknown \
//     --manifest-path crates/vector-wasm/Cargo.toml
//   npm run build --workspace @weisql/sdk
//   node tools/bench/wasm-adapter.mjs [path/to/weisql_vector_wasm.wasm]

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_WASM = new URL(
  "../../crates/vector-wasm/target/wasm32-unknown-unknown/release/weisql_vector_wasm.wasm",
  import.meta.url,
);
const sdkUrl =
  process.env.WEISQL_SDK_DIST !== undefined
    ? pathToFileURL(resolve(process.env.WEISQL_SDK_DIST))
    : new URL("../../packages/sdk/dist/index.js", import.meta.url);

const { WeiSQLError, createExactVectorAdapter, createWasmVectorAdapter } = await import(sdkUrl.href);

const COUNT = 6;
const DIMENSION = 3;
const TOP_K = 4;
const TOLERANCE = 1e-6;
const VECTORS = [
  [1, 0, 0],
  [0, 1, 0],
  [1, 1, 0],
  [-1, 0, 0],
  [0.5, 0.5, 0.5],
  [0, 0, 2],
];
const QUERY = Float32Array.from([1, 0.2, 0]);
const FILTER = new Set([1, 3, 5]);

function buildResources() {
  const flat = new Float32Array(COUNT * DIMENSION);
  VECTORS.forEach((row, index) => flat.set(row, index * DIMENSION));

  const lines = [];
  const offsets = new Uint8Array(COUNT * 8);
  const offsetsView = new DataView(offsets.buffer);
  let offset = 0;
  for (let row = 0; row < COUNT; row++) {
    const line = `${JSON.stringify({ row, id: `doc-${row}` })}\n`;
    offsetsView.setBigUint64(row * 8, BigInt(offset), true);
    lines.push(line);
    offset += new TextEncoder().encode(line).byteLength;
  }
  const ids = new TextEncoder().encode(lines.join(""));

  return new Map([
    ["vectors.f32", new Uint8Array(flat.buffer)],
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

function descriptor(metric) {
  const resources = buildResources();
  return {
    name: "documents",
    tableName: "documents",
    idColumn: "id",
    count: COUNT,
    dimension: DIMENSION,
    metric,
    encoding: "f32-le-row-major",
    data: { path: "vectors.f32", bytes: resources.get("vectors.f32").byteLength, sha256: "0".repeat(64) },
    idMap: {
      data: { path: "ids.jsonl", bytes: resources.get("ids.jsonl").byteLength, sha256: "0".repeat(64), format: "jsonl" },
      offsets: { path: "ids.offsets", bytes: resources.get("ids.offsets").byteLength, sha256: "0".repeat(64), format: "uint64-le" },
      count: COUNT,
      uniqueIds: true,
    },
  };
}

function compare(label, expected, actual) {
  if (actual.length !== expected.length) {
    throw new Error(`${label}: expected ${expected.length} hits, got ${actual.length}`);
  }
  for (let index = 0; index < expected.length; index++) {
    const left = expected[index];
    const right = actual[index];
    if (left.row !== right.row || left.id !== right.id) {
      throw new Error(`${label} position ${index}: ${JSON.stringify(left)} != ${JSON.stringify(right)}`);
    }
    if (Math.abs(left.distance - right.distance) > TOLERANCE) {
      throw new Error(`${label} position ${index}: distance ${left.distance} != ${right.distance}`);
    }
  }
}

async function searchWith(adapter, vector, query, allowedRows) {
  return adapter.search({
    vector,
    query,
    topK: TOP_K,
    ...(allowedRows === undefined ? {} : { allowedRows }),
  });
}

const argument = process.argv[2];
const wasmUrl = argument === undefined ? DEFAULT_WASM : pathToFileURL(resolve(argument));
const wasmBytes = await readFile(wasmUrl);

const exact = createExactVectorAdapter({ blockSize: 2 });
const wasm = await createWasmVectorAdapter({ module: wasmBytes, blockSize: 2 });
if (wasm.capabilities.engine !== "weisql-wasm-exact" || wasm.capabilities.exactSearch !== true) {
  throw new Error("unexpected WASM adapter capabilities");
}

const reader = buildReader(buildResources());
await exact.open({ manifest: {}, reader });
await wasm.open({ manifest: {}, reader });

let comparisons = 0;
for (const metric of ["cosine", "l2", "ip"]) {
  const vector = descriptor(metric);
  for (const filter of [undefined, FILTER]) {
    const label = `${metric}${filter === undefined ? "" : "-filtered"}`;
    const expected = await searchWith(exact, vector, QUERY, filter);
    const actual = await searchWith(wasm, vector, QUERY, filter);
    compare(label, expected, actual);
    comparisons += 1;
    console.log(`ok ${label}: ${actual.length} hits (rows ${actual.map(hit => hit.row).join(",")})`);
  }
}

for (const adapter of [exact, wasm]) {
  let code;
  try {
    await searchWith(adapter, descriptor("cosine"), Float32Array.from([0, 0, 0]), undefined);
  } catch (error) {
    code = error instanceof WeiSQLError ? error.code : String(error);
  }
  if (code !== "VECTOR_INVALID_VALUE") {
    throw new Error(`zero query should fail with VECTOR_INVALID_VALUE, got ${code}`);
  }
}
console.log("ok zero query rejected by both adapters");

await exact.close();
await wasm.close();
console.log(`wasm adapter parity: ${comparisons} comparisons`);
