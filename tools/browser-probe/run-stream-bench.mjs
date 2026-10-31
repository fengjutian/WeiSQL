/**
 * Measures browser SQL delivery with the real DuckDB-Wasm adapter.
 *
 *   npm run bench:wasm-stream
 *
 * Phase 1 streams `range()` rows (pure delivery path). Phase 2 builds a real
 * Parquet package in Node, serves it, and measures `open()` + streaming a
 * Parquet-backed table, plus the `db.sql()` array for comparison.
 *
 * Chromium only: heap numbers come from `performance.memory` (precise-memory-info
 * flag). This is a measurement device, not a performance promise.
 */
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { writeBenchPackage } from "./bench-package.mjs";
import { ensureParquetExtension } from "../fetch-duckdb-wasm-extension.mjs";
import { createProbeServer } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.resolve(HERE, "..", "..", ".cache");
const PACKAGE_DIR = path.join(CACHE, "browser-bench-200k");

function findChromium() {
  return [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean).find((candidate) => existsSync(candidate));
}

const executablePath = findChromium();
if (!executablePath) {
  console.error("No Chromium-based browser found. Set CHROME_PATH or install one.");
  process.exit(2);
}

await ensureParquetExtension("wasm_eh");
const browser = await chromium.launch({
  executablePath,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-precise-memory-info"],
});

async function collect(packageDirectory, pathname, timeout = 180_000) {
  const probe = createProbeServer(packageDirectory);
  const port = await probe.listen();
  const page = await browser.newPage();
  const logs = [];
  page.on("console", (message) => logs.push(message.text()));
  page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));
  try {
    await page.goto(`http://127.0.0.1:${port}${pathname}`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__BENCH_RESULT !== undefined, undefined, { timeout });
    return await page.evaluate(() => window.__BENCH_RESULT);
  } catch (error) {
    throw new Error(`benchmark ${pathname} did not finish: ${String(error).slice(0, 400)}\n${logs.join("\n")}`);
  } finally {
    await page.close();
    await probe.close();
  }
}

const fixture = path.resolve(HERE, "..", "..", "examples", "fixture");

let rangeResult;
const parquetResults = [];
const materializeResults = [];
try {
  rangeResult = await collect(fixture, "/wasm-stream-bench");
  if (rangeResult?.ok !== true) throw new Error(`range benchmark failed: ${JSON.stringify(rangeResult)}`);

  for (const rows of [200_000, 500_000]) {
    const directory = path.join(PACKAGE_DIR, String(rows));
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const pkg = await writeBenchPackage(directory, rows);
    const result = await collect(directory, "/wasm-parquet-bench");
    if (result?.ok !== true) throw new Error(`parquet benchmark (${rows}) failed: ${JSON.stringify(result)}`);
    result.rows = rows;
    result.parquetMB = Number((pkg.parquetBytes / (1024 * 1024)).toFixed(1));
    parquetResults.push(result);
  }

  // Larger sizes only measure `open()`: fetching a million rows with `db.sql`
  // would measure the array, not the materialization curve.
  for (const rows of [200_000, 500_000, 1_000_000, 2_000_000]) {
    const directory = path.join(PACKAGE_DIR, `mat-${rows}`);
    await rm(directory, { recursive: true, force: true });
    await mkdir(directory, { recursive: true });
    const pkg = await writeBenchPackage(directory, rows);
    const result = await collect(directory, "/wasm-materialize-bench", 300_000);
    if (result?.ok !== true) throw new Error(`materialize benchmark (${rows}) failed: ${JSON.stringify(result)}`);
    result.expectedRows = rows;
    result.parquetMB = Number((pkg.parquetBytes / (1024 * 1024)).toFixed(1));
    materializeResults.push(result);
  }
} catch (error) {
  console.error(String(error).slice(0, 1200));
  await browser.close();
  process.exit(1);
}

console.log("Synthetic rows (`range()`), delivery path only:");
console.log("| mode | rows | first row | total | rows/s | heap delta |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
for (const row of rangeResult.stream) {
  console.log(`| sqlStream | ${row.rows} | ${row.firstRowMs} ms | ${row.totalMs} ms | ${row.rowsPerSecond} | ${row.heapDeltaMB ?? "-"} MB |`);
}
for (const row of rangeResult.materialized) {
  console.log(`| db.sql | ${row.rows} | - | ${row.totalMs} ms | - | ${row.heapDeltaMB ?? "-"} MB |`);
}

console.log("");
console.log("Real Parquet packages (HTTP Range + L3 + materialize):");
console.log("| rows | parquet | open() | open heap | sqlStream | first row | stream heap | db.sql | db.sql heap |");
console.log("| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const result of parquetResults) {
  console.log(`| ${result.rows} | ${result.parquetMB} MB | ${result.openMs} ms | +${result.openHeapDeltaMB ?? "-"} MB | ${result.stream.totalMs} ms (${result.stream.rowsPerSecond} rows/s) | ${result.stream.firstRowMs} ms | +${result.stream.heapDeltaMB ?? "-"} MB | ${result.materialized.totalMs} ms | +${result.materialized.heapDeltaMB ?? "-"} MB |`);
}

console.log("");
console.log("Materialization memory curve (real Parquet, open() only):");
console.log("| rows | parquet | open() | heap delta | engine memory | cross-origin isolated |");
console.log("| ---: | ---: | ---: | ---: | ---: | --- |");
for (const result of materializeResults) {
  console.log(`| ${result.rows} | ${result.parquetMB} MB | ${result.openMs} ms | +${result.heapDeltaMB ?? "-"} MB | ${result.engineMemoryMB ?? "-"} MB | ${result.crossOriginIsolated} |`);
}

await browser.close();
process.exit(0);
