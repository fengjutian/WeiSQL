/**
 * Measures browser streaming throughput with the real DuckDB-Wasm adapter.
 *
 *   npm run bench:wasm-stream
 *
 * Chromium only: heap numbers come from `performance.memory` (precise-memory-info
 * flag). This is a measurement device, not a performance promise.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { chromium } from "playwright-core";

import { ensureParquetExtension } from "../fetch-duckdb-wasm-extension.mjs";
import { createProbeServer } from "./server.mjs";

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
const probe = createProbeServer();
const port = await probe.listen();
const browser = await chromium.launch({
  executablePath,
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--enable-precise-memory-info"],
});
const page = await browser.newPage();
const logs = [];
page.on("console", (message) => logs.push(message.text()));
page.on("pageerror", (error) => logs.push(`pageerror: ${error.message}`));

let result;
try {
  await page.goto(`http://127.0.0.1:${port}/wasm-stream-bench`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__BENCH_RESULT !== undefined, undefined, { timeout: 180_000 });
  result = await page.evaluate(() => window.__BENCH_RESULT);
} catch (error) {
  console.error(`benchmark did not finish: ${String(error).slice(0, 400)}`);
  console.error(logs.join("\n"));
  await browser.close();
  await probe.close();
  process.exit(1);
}

if (result?.ok !== true) {
  console.error(JSON.stringify(result, null, 2));
  await browser.close();
  await probe.close();
  process.exit(1);
}

console.log("| mode | rows | first row | total | rows/s | heap delta |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: |");
for (const row of result.stream) {
  console.log(`| sqlStream | ${row.rows} | ${row.firstRowMs} ms | ${row.totalMs} ms | ${row.rowsPerSecond} | ${row.heapDeltaMB ?? "-"} MB |`);
}
for (const row of result.materialized) {
  console.log(`| db.sql | ${row.rows} | - | ${row.totalMs} ms | - | ${row.heapDeltaMB ?? "-"} MB |`);
}

await browser.close();
await probe.close();
process.exit(0);
