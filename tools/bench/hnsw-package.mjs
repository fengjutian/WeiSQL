#!/usr/bin/env node
// End-to-end package test: build an HNSW index into a copy of the example
// package, then let the SDK adapter consume it through the Manifest.
//
//   npm run build:hnsw-wasm
//   npm run build --workspace @weisql/sdk
//   node tools/bench/hnsw-package.mjs [path/to/weisql_vector_hnsw_wasm.wasm]

import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const DEFAULT_WASM = fileURLToPath(
  new URL("../../crates/vector-hnsw-wasm/target/wasm32-unknown-unknown/release/weisql_vector_hnsw_wasm.wasm", import.meta.url),
);
const FIXTURE = fileURLToPath(new URL("../../examples/fixture", import.meta.url));
const TOOL = fileURLToPath(new URL("../build-hnsw-index.mjs", import.meta.url));
const sdkUrl =
  process.env.WEISQL_SDK_DIST !== undefined
    ? pathToFileURL(path.resolve(process.env.WEISQL_SDK_DIST))
    : new URL("../../packages/sdk/dist/index.js", import.meta.url);

const { NodeFileResourceReader, createExactVectorAdapter, createHnswWasmVectorAdapter, sha256Hex, validateManifest } = await import(sdkUrl.href);

const wasmPath = process.argv[2] === undefined ? DEFAULT_WASM : path.resolve(process.argv[2]);
const directory = await mkdtemp(path.join(tmpdir(), "weisql-hnsw-package-"));
let reader;

try {
  await cp(FIXTURE, directory, { recursive: true });

  const built = spawnSync(
    process.execPath,
    [TOOL, directory, "--wasm", wasmPath, "--recall-samples", "3", "--recall-top-k", "2", "--min-recall", "0.5"],
    { stdio: "inherit" },
  );
  if (built.status !== 0) throw new Error(`build-hnsw-index.mjs exited with ${built.status}`);
  console.log("ok tool: index built into the package");

  const manifestPath = path.join(directory, "manifest.json");
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const collection = manifest.vectorCollections[0];
  if (collection.index === undefined) throw new Error("Manifest is missing the index entry");
  if (collection.index.engine !== "weisql-hnsw") throw new Error(`unexpected engine ${collection.index.engine}`);
  if (collection.index.version !== "1") throw new Error(`unexpected format version ${collection.index.version}`);

  const indexBytes = await readFile(path.join(directory, ...collection.index.file.path.split("/")));
  if (indexBytes.byteLength !== collection.index.file.bytes) throw new Error("index byte length does not match the Manifest");
  if (sha256Hex(indexBytes) !== collection.index.file.sha256) throw new Error("index digest does not match the Manifest");
  console.log(`ok tool: ${indexBytes.byteLength} bytes, digest matches the Manifest`);

  reader = new NodeFileResourceReader({ rootDirectory: directory });
  const wasmBytes = await readFile(wasmPath);
  const exact = createExactVectorAdapter();
  const hnsw = await createHnswWasmVectorAdapter({ module: wasmBytes });
  await exact.open({ manifest, reader });
  await hnsw.open({ manifest, reader });

  const rowBytes = collection.dimension * Float32Array.BYTES_PER_ELEMENT;
  const queryBytes = await reader.readRange(collection.data.path, { start: 0, end: rowBytes });
  const query = new Float32Array(queryBytes.buffer, queryBytes.byteOffset, collection.dimension);

  const request = {
    vector: collection,
    query,
    topK: Math.min(3, collection.count),
  };
  const expected = await exact.search(request);
  const actual = await hnsw.search(request);
  if (actual.length !== expected.length) throw new Error(`expected ${expected.length} hits, got ${actual.length}`);
  for (let position = 0; position < actual.length; position++) {
    if (actual[position].row !== expected[position].row) {
      throw new Error(`position ${position}: row ${actual[position].row} != ${expected[position].row}`);
    }
    if (Math.abs(actual[position].distance - expected[position].distance) > 1e-9) {
      throw new Error(`position ${position}: distance ${actual[position].distance} != ${expected[position].distance}`);
    }
  }
  if (hnsw.capabilities.persistedIndex !== true) throw new Error("adapter must report persistedIndex: true");
  console.log(`ok adapter: ${actual.length} hits match the exact adapter via the Manifest index`);

  await exact.close();
  await hnsw.close();
} finally {
  if (reader !== undefined) await reader.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
