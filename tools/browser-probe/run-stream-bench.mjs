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
let parquetResult;
try {
  rangeResult = await collect(fixture, "/wasm-stream-bench");
  if (rangeResult?.ok !== true) throw new Error(`range benchmark failed: ${JSON.stringify(rangeResult)}`);

  await rm(PACKAGE_DIR, { recursive: true, force: true });
  await mkdir(PACKAGE_DIR, { recursive: true });
  const pkg = await writeBenchPackage(PACKAGE_DIR, 200_000);
  parquetResult = await collect(PACKAGE_DIR, "/wasm-parquet-bench");
  if (parquetResult?.ok !== true) throw new Error(`parquet benchmark failed: ${JSON.stringify(parquetResult)}`);
  parquetResult.parquetMB = Number((pkg.parquetBytes / (1024 * 1024)).toFixed(1));
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
console.log(`Real Parquet package (${parquetResult.parquetMB} MB, 200k rows, HTTP Range + L3 + materialize):`);
console.log("| step | result |");
console.log("| --- | --- |");
console.log(`| open() (materialize + L4) | ${parquetResult.openMs} ms, heap +${parquetResult.openHeapDeltaMB ?? "-"} MB |`);
console.log(`| sqlStream rows | ${parquetResult.stream.rows} rows, first row ${parquetResult.stream.firstRowMs} ms, ${parquetResult.stream.totalMs} ms total, ${parquetResult.stream.rowsPerSecond} rows/s, heap +${parquetResult.stream.heapDeltaMB ?? "-"} MB |`);
console.log(`| db.sql rows | ${parquetResult.materialized.rows} rows, ${parquetResult.materialized.totalMs} ms, heap +${parquetResult.materialized.heapDeltaMB ?? "-"} MB |`);

await browser.close();
process.exit(0);
