/**
 * Reproducible exact-search measurement for WeiSQL packages.
 *
 *   npm run bench                 # default: 100k rows x 128 dims, 20 queries
 *   npm run bench -- --rows 20000 --dimension 64 --queries 10
 *
 * This is a measurement device, not a performance claim: it prints the hardware
 * and runtime it ran on, and every number is warm-page-cache on one machine.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { validatePackage } from "@weisql/cli";
import { NodeFileResourceReader, open } from "@weisql/sdk";
import { createUSearchAdapter } from "@weisql/usearch-adapter";

const run = promisify(execFile);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

function readArguments(argv) {
  const options = {
    rows: 100_000,
    dimension: 128,
    queries: 20,
    topK: 10,
    packageDirectory: undefined,
    skipGenerate: false,
    ann: false,
    expansionSearch: 512,
    text: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--rows": options.rows = Number(value); index++; break;
      case "--dimension": options.dimension = Number(value); index++; break;
      case "--queries": options.queries = Number(value); index++; break;
      case "--topk": options.topK = Number(value); index++; break;
      case "--package": options.packageDirectory = value; index++; break;
      case "--no-generate": options.skipGenerate = true; break;
      case "--ann": options.ann = true; break;
      case "--expansion-search": options.expansionSearch = Number(value); index++; break;
      case "--text": options.text = true; break;
      default: throw new Error(`unknown option ${flag}`);
    }
  }
  options.packageDirectory ??= path.join(REPO_ROOT, "bench", `pkg-${options.rows}x${options.dimension}`);
  return options;
}

/** Counts what the runtime actually asks the reader for. */
class CountingReader {
  constructor(inner) {
    this.inner = inner;
    this.rangeRequests = 0;
    this.rangeBytes = 0;
    this.fullReads = 0;
    this.statCalls = 0;
    this.bytesByPath = new Map();
  }
  async read(pathname, options) {
    this.fullReads++;
    const bytes = await this.inner.read(pathname, options);
    this.rangeBytes += bytes.byteLength;
    return bytes;
  }
  async readRange(pathname, range, options) {
    this.rangeRequests++;
    const bytes = await this.inner.readRange(pathname, range, options);
    this.rangeBytes += bytes.byteLength;
    this.bytesByPath.set(pathname, (this.bytesByPath.get(pathname) ?? 0) + bytes.byteLength);
    return bytes;
  }
  async stat(pathname, options) {
    this.statCalls++;
    return this.inner.stat(pathname, options);
  }
  async close() {
    return this.inner.close();
  }
}

/** Deterministic query vectors so two runs are comparable. */
function makeQueries(count, dimension, seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  };
  return Array.from({ length: count }, () => {
    const vector = new Float32Array(dimension);
    for (let i = 0; i < dimension; i++) vector[i] = next() * 2 - 1;
    return vector;
  });
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

function megabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const options = readArguments(process.argv.slice(2));

// Regenerate by default: a stale package from an older generator silently
// invalidates the whole measurement (for example a new text column missing).
// Use --no-generate to reuse a package deliberately.
if (!options.skipGenerate) {
  console.log(`generating package: ${options.packageDirectory}`);
  execFileSync("python", [
    path.join(HERE, "make-bench-package.py"),
    "--output", options.packageDirectory,
    "--rows", String(options.rows),
    "--dimension", String(options.dimension),
  ], { stdio: "inherit" });
} else if (!existsSync(path.join(options.packageDirectory, "manifest.json"))) {
  throw new Error(`package not found: ${options.packageDirectory}`);
}

// Integrity gate: never measure a package that fails L1/L2/L3.
const validationStarted = performance.now();
const validation = await validatePackage({ directory: options.packageDirectory, mode: "all" });
const validationMs = performance.now() - validationStarted;
if (!validation.ok) {
  console.error(`package failed validation: ${JSON.stringify(validation.issues, null, 2)}`);
  process.exit(1);
}

const manifest = validation.manifest;
const collection = manifest.vectorCollections[0];
const queries = makeQueries(options.queries, collection.dimension, 12345);

let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 20);
sampler.unref();

const openStarted = performance.now();
const inner = new NodeFileResourceReader({ rootDirectory: options.packageDirectory });
const reader = new CountingReader(inner);
const db = await open({ manifest, resourceReader: reader });
const openMs = performance.now() - openStarted;

const latencies = [];
const exactIds = [];
let hits = 0;
for (const query of queries) {
  const started = performance.now();
  const results = await db.vector.search(collection.name, query, { topK: options.topK });
  latencies.push(performance.now() - started);
  hits += results.length;
  exactIds.push(results.map(hit => hit.id));
}
await db.close();

// Optional ANN phase: same queries, same package, measured against the exact
// results above so Recall@K is a real number instead of a parameter claim.
let ann;
if (options.ann) {
  const annReader = new NodeFileResourceReader({ rootDirectory: options.packageDirectory });
  const annDb = await open({
    manifest,
    resourceReader: annReader,
    vectorAdapter: createUSearchAdapter({ expansionSearch: options.expansionSearch }),
  });
  const annLatencies = [];
  const annIds = [];
  const buildStarted = performance.now();
  const first = await annDb.vector.search(collection.name, queries[0], { topK: options.topK });
  const buildAndFirstMs = performance.now() - buildStarted;
  annIds.push(first.map(hit => hit.id));
  for (const query of queries.slice(1)) {
    const started = performance.now();
    const results = await annDb.vector.search(collection.name, query, { topK: options.topK });
    annLatencies.push(performance.now() - started);
    annIds.push(results.map(hit => hit.id));
  }
  await annDb.close();

  const recalls = annIds.map((ids, index) => {
    const truth = new Set(exactIds[index]);
    const denominator = Math.max(1, truth.size);
    return ids.filter(id => truth.has(id)).length / denominator;
  });
  const warm = [...annLatencies].sort((left, right) => left - right);
  ann = {
    expansionSearch: options.expansionSearch,
    buildAndFirstQueryMs: Number(buildAndFirstMs.toFixed(1)),
    note: "the first ANN query pays the full index build; the timings below exclude it",
    search: {
      minMs: Number(warm[0].toFixed(3)),
      p50Ms: Number(percentile(warm, 0.5).toFixed(3)),
      p95Ms: Number(percentile(warm, 0.95).toFixed(3)),
      maxMs: Number(warm[warm.length - 1].toFixed(3)),
      samples: warm.length,
    },
    recall: {
      mean: Number((recalls.reduce((sum, value) => sum + value, 0) / recalls.length).toFixed(4)),
      min: Number(Math.min(...recalls).toFixed(4)),
      perQuery: recalls.map(value => Number(value.toFixed(3))),
      topK: options.topK,
    },
  };
}
// Optional full-text phase: builds the index with the real generator, then
// measures BM25 query latency. Index build time is reported separately because
// it is a one-off cost, unlike the per-query numbers below.
let text;
if (options.text) {
  const buildStarted = performance.now();
  await run(process.execPath, [
    path.join(REPO_ROOT, "tools", "build-text-index.mjs"),
    options.packageDirectory,
    "--table", "documents",
    "--column", "body",
    "--name", "documents_body_text",
  ], { stdio: "ignore" });
  const textBuildMs = performance.now() - buildStarted;

  const updatedManifest = JSON.parse(await readFile(path.join(options.packageDirectory, "manifest.json"), "utf8"));
  const entry = updatedManifest.textIndexes?.find(item => item.name === "documents_body_text");
  if (entry === undefined) throw new Error("text index was not recorded in the Manifest");
  const indexBytes = entry.data.bytes + entry.termOffsets.bytes + entry.docLengths.bytes + entry.idMap.data.bytes + entry.idMap.offsets.bytes
    + (entry.documents?.data.bytes ?? 0) + (entry.documents?.offsets.bytes ?? 0);
  const indexBreakdown = {
    terms: entry.data.bytes,
    termOffsets: entry.termOffsets.bytes,
    docLengths: entry.docLengths.bytes,
    ids: entry.idMap.data.bytes + entry.idMap.offsets.bytes,
    documents: (entry.documents?.data.bytes ?? 0) + (entry.documents?.offsets.bytes ?? 0),
  };

  const textReader = new NodeFileResourceReader({ rootDirectory: options.packageDirectory });
  // Checksums were just verified by the generator; hashing 100k documents again
  // would measure SHA-256, not search.
  const textDb = await open({ manifest: updatedManifest, resourceReader: textReader, verifyChecksums: "none" });
  const textLatencies = [];
  let textHits = 0;
  for (let index = 0; index < options.queries; index++) {
    const word = `w${String((index * 137) % 5000).padStart(4, "0")}`;
    const started = performance.now();
    const results = await textDb.text.search("documents_body_text", word, { topK: options.topK });
    textLatencies.push(performance.now() - started);
    textHits += results.length;
  }
  await textDb.close();
  await textReader.close();

  const sortedText = [...textLatencies].sort((left, right) => left - right);
  text = {
    column: "body",
    documents: entry.documentCount,
    distinctTerms: entry.termCount,
    averageDocumentLength: Number(entry.averageDocumentLength.toFixed(2)),
    indexBytes,
    indexBreakdown,
    bytesPerDocument: Math.round(indexBytes / entry.documentCount),
    buildMs: Number(textBuildMs.toFixed(1)),
    search: {
      coldMs: Number(textLatencies[0].toFixed(3)),
      minMs: Number(sortedText[0].toFixed(3)),
      p50Ms: Number(percentile(sortedText, 0.5).toFixed(3)),
      p95Ms: Number(percentile(sortedText, 0.95).toFixed(3)),
      maxMs: Number(sortedText[sortedText.length - 1].toFixed(3)),
      averageMs: Number((textLatencies.reduce((sum, value) => sum + value, 0) / textLatencies.length).toFixed(3)),
      totalHits: textHits,
    },
    note: "BM25 is exact; there is no recall/precision trade-off to report. Build time includes reading the Parquet text column.",
  };
}
clearInterval(sampler);

const sorted = [...latencies].sort((left, right) => left - right);
const result = {
  package: path.relative(REPO_ROOT, options.packageDirectory),
  rows: collection.count,
  dimension: collection.dimension,
  vectorBytes: collection.data.bytes,
  queries: options.queries,
  topK: options.topK,
  validationMs: Number(validationMs.toFixed(1)),
  openMs: Number(openMs.toFixed(1)),
  search: {
    coldMs: Number(latencies[0].toFixed(1)),
    minMs: Number(sorted[0].toFixed(1)),
    p50Ms: Number(percentile(sorted, 0.5).toFixed(1)),
    p95Ms: Number(percentile(sorted, 0.95).toFixed(1)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(1)),
    averageMs: Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(1)),
    totalHits: hits,
  },
  io: {
    rangeRequests: reader.rangeRequests,
    rangeBytes: reader.rangeBytes,
    rangeBytesPerQuery: Math.round(reader.rangeBytes / options.queries),
    fullReads: reader.fullReads,
    statCalls: reader.statCalls,
  },
  memory: {
    peakRssBytes: peakRss,
    peakRss: megabytes(peakRss),
    heapUsedBytes: process.memoryUsage().heapUsed,
  },
  host: {
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    totalMemory: megabytes(os.totalmem()),
    node: process.version,
  },
  caveats: [
    "single machine, warm page cache; not a product performance claim",
    "validation ran first, so the OS cache was already populated",
    "latency includes Range reads, distance scan, Top-K and final ID lookup",
    ...(options.ann ? ["ANN recall is measured on synthetic uniform vectors, the worst case for HNSW; it does not predict real embeddings"] : []),
  ],
};

if (ann !== undefined) result.ann = ann;
if (text !== undefined) result.text = text;

console.log(JSON.stringify(result, null, 2));
