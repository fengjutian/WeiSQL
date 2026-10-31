/**
 * Measures DuckDB-Wasm table materialization and a filtered query as row counts
 * grow.
 *
 *   npm run bench:wasm
 *   npm run bench:wasm -- 50000 200000 500000
 *
 * This is a *measurement device*, not a performance promise. It runs the same
 * WASM build and the same adapter code as the browser, but inside Node, so the
 * numbers show engine scaling only: no browser overhead, no network, no UI.
 * Memory is `process.memoryUsage()` after an explicit GC and includes the WASM
 * heap, but not the browser's own overhead.
 *
 * The generated columns are deliberately low-compressibility (random hex ids and
 * random scores); a linear `index / rows` column would compress to almost
 * nothing and make the materialization numbers meaningless.
 */
import { parquetWriteBuffer } from "hyparquet-writer";

import { createDuckDbWasmAdapter } from "../../packages/duckdb-wasm-adapter/dist/index.js";
// The test harness exposes the blocking bindings through the same async shape
// the adapter uses in the browser, so the measured code path is not a copy.
import { createWasmTestDatabase } from "../../packages/duckdb-wasm-adapter/test/helpers/wasm-database.mjs";

const SMOKE = process.argv.includes("--smoke");
const SIZES = SMOKE
  ? [1_000]
  : process.argv.length > 2 && !process.argv[2].startsWith("--")
    ? process.argv.slice(2).map(Number)
    : [50_000, 200_000, 500_000];
const CATEGORIES = ["genetics", "metabolism", "ecology", "other"];
const HEX = "0123456789abcdef";

/** Deterministic PRNG so repeated runs compare the same bytes. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function makeParquet(rows) {
  const random = mulberry32(rows);
  const ids = new Array(rows);
  const categories = new Array(rows);
  const scores = new Array(rows);
  for (let index = 0; index < rows; index += 1) {
    let id = "";
    for (let character = 0; character < 32; character += 1) id += HEX[Math.floor(random() * 16)];
    ids[index] = id;
    categories[index] = CATEGORIES[Math.floor(random() * CATEGORIES.length)];
    scores[index] = random();
  }
  return new Uint8Array(parquetWriteBuffer({
    columnData: [
      { name: "id", type: "STRING", data: ids },
      { name: "category", type: "STRING", data: categories },
      { name: "score", type: "DOUBLE", data: scores },
    ],
  }));
}

function manifestFor(rows, table, bytes) {
  return {
    format: "weisql",
    formatVersion: "1.0.0",
    datasetId: `wasm-bench-${rows}`,
    tables: [{
      name: table,
      file: { path: "data/documents.parquet", bytes: bytes.byteLength, sha256: "0".repeat(64) },
      format: "parquet",
      columns: [
        { name: "id", type: "string", nullable: false },
        { name: "category", type: "string", nullable: false },
        { name: "score", type: "float64", nullable: false },
      ],
      primaryKey: ["id"],
    }],
    vectorCollections: [],
  };
}

function readerFor(bytes) {
  return {
    read: async () => bytes,
    readRange: async (_path, range) => bytes.subarray(range.start, range.end),
  };
}

const megabytes = value => Number((value / (1024 * 1024)).toFixed(1));
const collectGarbage = () => {
  if (typeof global.gc === "function") {
    global.gc();
    global.gc();
  }
};
const snapshot = () => {
  collectGarbage();
  const usage = process.memoryUsage();
  return { rss: usage.rss, external: usage.external };
};

async function measure(size, { report = true } = {}) {
  const table = `documents_${size}`;
  const bytes = makeParquet(size);
  const manifest = manifestFor(size, table, bytes);
  const database = await createWasmTestDatabase();
  const adapter = createDuckDbWasmAdapter({ database, verifyTableSchema: true });
  const before = snapshot();

  const startedAt = performance.now();
  await adapter.open({ manifest, reader: readerFor(bytes) });
  const openMs = Math.round(performance.now() - startedAt);
  const afterOpen = snapshot();

  const queryStart = performance.now();
  const filtered = await adapter.query(`SELECT count(*) AS n FROM "${table}" WHERE category = ?`, ["genetics"]);
  const queryMs = Number((performance.now() - queryStart).toFixed(1));
  const afterQuery = snapshot();

  await adapter.close();
  await database.terminate();

  if (report) console.log(`measured ${size} rows`);
  return {
    rows: size,
    parquetMB: megabytes(bytes.byteLength),
    openMs,
    queryMs,
    filtered: Number(filtered[0].n),
    rssDeltaMB: megabytes(Math.max(0, afterOpen.rss - before.rss)),
    externalDeltaMB: megabytes(Math.max(0, afterQuery.external - before.external)),
  };
}

// Warm up the WASM module and the extension before measuring; otherwise the
// first measured size absorbs all of the instantiation cost. The smoke run is
// already tiny, so it skips the warmup pass.
if (!SMOKE && process.env.WEISQL_WASM_BENCH_NO_WARMUP !== "1") {
  await measure(1_000, { report: false });
}

const results = [];
for (const size of SIZES) {
  results.push(await measure(size));
}

console.log("");
console.log("| rows | parquet | open() | filtered query | RSS delta | external delta |");
console.log("| ---: | ---: | ---: | ---: | ---: | ---: |");
for (const row of results) {
  console.log(`| ${row.rows} | ${row.parquetMB} MB | ${row.openMs} ms | ${row.queryMs} ms | ~${row.rssDeltaMB} MB | ~${row.externalDeltaMB} MB |`);
}
console.log("");
console.log("filtered counts:", results.map(row => `${row.rows}:${row.filtered}`).join(", "));
