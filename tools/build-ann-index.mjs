/**
 * Builds a persisted USearch index for a package and records it in the Manifest.
 *
 *   node tools/build-ann-index.mjs <package-dir> [--collection name]
 *        [--connectivity 16] [--expansion-add 128] [--expansion-search 512]
 *
 * The index is written to `indexes/<collection>.usearch`, the Manifest gains an
 * `index` entry with the build parameters, and the result is re-validated before
 * it is saved. Run `weisql validate <package-dir>` afterwards as a second check.
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

const USEARCH_VERSION = packageVersion("usearch");

const METRIC = { cosine: "cos", l2: "l2sq", ip: "ip" };

function parse(arguments_) {
  const options = { directory: undefined, collection: undefined, connectivity: 16, expansionAdd: 128, expansionSearch: 512 };
  for (let index = 0; index < arguments_.length; index++) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === "--collection") { options.collection = value; index++; }
    else if (flag === "--connectivity") { options.connectivity = Number(value); index++; }
    else if (flag === "--expansion-add") { options.expansionAdd = Number(value); index++; }
    else if (flag === "--expansion-search") { options.expansionSearch = Number(value); index++; }
    else if (flag.startsWith("--")) throw new Error(`unknown option ${flag}`);
    else if (options.directory === undefined) options.directory = flag;
    else throw new Error(`unexpected argument ${flag}`);
  }
  if (options.directory === undefined) throw new Error("usage: node tools/build-ann-index.mjs <package-dir>");
  return options;
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
const index = new Index({
  metric: METRIC[collection.metric],
  dimensions: collection.dimension,
  quantization: "f32",
  connectivity: options.connectivity,
  expansion_add: options.expansionAdd,
  expansion_search: options.expansionSearch,
  multi: false,
});

const started = performance.now();
const rowBytes = collection.dimension * 4;
const batchRows = 4096;
for (let startRow = 0; startRow < collection.count; startRow += batchRows) {
  const rows = Math.min(batchRows, collection.count - startRow);
  const bytes = await reader.readRange(collection.data.path, { start: startRow * rowBytes, end: (startRow + rows) * rowBytes });
  if (bytes.byteLength !== rows * rowBytes) throw new Error("vector block length mismatch while building the index");
  const vectors = new Float32Array(bytes.buffer, bytes.byteOffset, rows * collection.dimension);
  const keys = new BigUint64Array(rows);
  for (let row = 0; row < rows; row++) keys[row] = BigInt(startRow + row);
  index.add(keys, vectors);
}
await reader.close();

const staging = await mkdtemp(path.join(tmpdir(), "weisql-ann-index-"));
const stagedFile = path.join(staging, "index.bin");
index.save(stagedFile);
const indexBytes = new Uint8Array(await readFile(stagedFile));
const relativePath = `indexes/${collection.name}.usearch`;
await mkdir(path.join(directory, "indexes"), { recursive: true });
await writeFile(path.join(directory, ...relativePath.split("/")), indexBytes);
await rm(staging, { recursive: true, force: true });

collection.index = {
  engine: "usearch",
  version: USEARCH_VERSION,
  file: { path: relativePath, bytes: indexBytes.byteLength, sha256: sha256Hex(indexBytes) },
  params: {
    connectivity: options.connectivity,
    expansion_add: options.expansionAdd,
    expansion_search: options.expansionSearch,
  },
};

// Re-validate before writing: an invalid Manifest must never reach disk.
validateManifest(manifest);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  package: directory,
  collection: collection.name,
  engine: "usearch",
  version: USEARCH_VERSION,
  vectors: collection.count,
  dimensions: collection.dimension,
  indexBytes: indexBytes.byteLength,
  bytesPerVector: Math.round(indexBytes.byteLength / Math.max(1, collection.count)),
  buildMs: Math.round(performance.now() - started),
  params: collection.index.params,
  next: `weisql validate ${path.relative(process.cwd(), directory) || "."}`,
}, null, 2));
