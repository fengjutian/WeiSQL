#!/usr/bin/env node
/**
 * Copies the two WASM vector artifacts into `@weisql/sdk` so npm consumers do
 * not need a Rust toolchain, and writes `wasm/artifacts.json` with sizes,
 * SHA-256 digests, ABI versions and required exports.
 *
 *   npm run build:wasm && npm run build:hnsw-wasm
 *   node tools/embed-wasm.mjs            # refresh packages/sdk/wasm
 *   node tools/embed-wasm.mjs --check    # verify the checked-in artifacts only
 *
 * The files are committed on purpose: `npm publish` must ship exactly the
 * bytes that were tested, not a machine-specific rebuild. `--check` is what
 * `release:check` runs, so a stale or truncated artifact stops a release.
 */
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIRECTORY = path.join(ROOT, "packages", "sdk", "wasm");
const MANIFEST_PATH = path.join(OUTPUT_DIRECTORY, "artifacts.json");

const ARTIFACTS = [
  {
    name: "weisql_vector_wasm.wasm",
    source: path.join(ROOT, "crates", "vector-wasm", "target", "wasm32-unknown-unknown", "release", "weisql_vector_wasm.wasm"),
    abiFunction: "weisql_abi_version",
    requiredExports: ["weisql_abi_version", "weisql_alloc", "weisql_dealloc", "weisql_search_topk"],
  },
  {
    name: "weisql_vector_hnsw_wasm.wasm",
    source: path.join(ROOT, "crates", "vector-hnsw-wasm", "target", "wasm32-unknown-unknown", "release", "weisql_vector_hnsw_wasm.wasm"),
    abiFunction: "weisql_hnsw_abi_version",
    requiredExports: [
      "weisql_hnsw_abi_version",
      "weisql_hnsw_alloc",
      "weisql_hnsw_dealloc",
      "weisql_hnsw_build",
      "weisql_hnsw_search",
      "weisql_hnsw_save",
      "weisql_hnsw_load",
      "weisql_hnsw_serialized_len",
      "weisql_hnsw_dimension",
      "weisql_hnsw_len",
      "weisql_hnsw_metric",
    ],
  },
];

const checkOnly = process.argv.includes("--check");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function inspect(bytes, artifact) {
  const module = await WebAssembly.compile(bytes);
  const exports = new Set(WebAssembly.Module.exports(module).map(entry => entry.name));
  for (const name of artifact.requiredExports) {
    if (!exports.has(name)) throw new Error(`${artifact.name} is missing the '${name}' export`);
  }
  const instance = await WebAssembly.instantiate(module, {});
  const version = instance.exports[artifact.abiFunction];
  if (typeof version !== "function") throw new Error(`${artifact.name} is missing ${artifact.abiFunction}()`);
  const abiVersion = version();
  if (!Number.isSafeInteger(abiVersion) || abiVersion <= 0) {
    throw new Error(`${artifact.name} returned an invalid ABI version: ${abiVersion}`);
  }
  return { exports: [...exports].sort(), abiVersion };
}

async function readArtifact(artifact) {
  let bytes;
  try {
    bytes = await readFile(checkOnly ? path.join(OUTPUT_DIRECTORY, artifact.name) : artifact.source);
  } catch (cause) {
    const hint = checkOnly
      ? `run 'node tools/embed-wasm.mjs' to refresh ${path.relative(ROOT, OUTPUT_DIRECTORY)}`
      : `run 'npm run build:wasm' and 'npm run build:hnsw-wasm' first`;
    throw new Error(`missing ${artifact.name}; ${hint}`, { cause });
  }
  if (bytes.byteLength === 0) throw new Error(`${artifact.name} is empty`);
  const details = await inspect(bytes, artifact);
  return { bytes, ...details };
}

async function main() {
  await mkdir(OUTPUT_DIRECTORY, { recursive: true });
  const records = [];
  for (const artifact of ARTIFACTS) {
    const { bytes, abiVersion, exports } = await readArtifact(artifact);
    if (!checkOnly && artifact.source !== path.join(OUTPUT_DIRECTORY, artifact.name)) {
      await copyFile(artifact.source, path.join(OUTPUT_DIRECTORY, artifact.name));
    }
    const destination = await readFile(path.join(OUTPUT_DIRECTORY, artifact.name));
    if (!destination.equals(bytes)) throw new Error(`${artifact.name} changed while being embedded`);
    records.push({
      name: artifact.name,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
      abiVersion,
      exports,
    });
  }

  const expected = `${JSON.stringify({ formatVersion: 1, artifacts: records }, null, 2)}\n`;
  if (checkOnly) {
    const actual = await readFile(MANIFEST_PATH, "utf8").catch(() => "");
    if (actual !== expected) {
      throw new Error("packages/sdk/wasm/artifacts.json does not match the checked-in bytes; regenerate the wasm artifacts");
    }
    console.log(`verified ${records.length} WASM artifacts in packages/sdk/wasm`);
    return;
  }

  await writeFile(MANIFEST_PATH, expected, "utf8");
  for (const record of records) {
    console.log(`${record.name}: ${record.bytes} bytes, abi ${record.abiVersion}, sha256 ${record.sha256.slice(0, 12)}…`);
  }
}

await main();
