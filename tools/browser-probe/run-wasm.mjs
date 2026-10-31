/**
 * Runs the DuckDB-Wasm probe in a real Chromium and exits non-zero on failure.
 *
 *   npm run probe:wasm
 *
 * Unlike `probe:browser`, this one exercises the SQL path: DuckDB-Wasm is
 * downloaded from the local static server, the parquet extension comes from
 * extensions.duckdb.org (or the configured repository), and tables are
 * materialized from bytes read through the SDK's HttpResourceReader.
 */
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";

import { ensureParquetExtension } from "../fetch-duckdb-wasm-extension.mjs";
import { createProbeServer } from "./server.mjs";

function findChromium() {
  const cache = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
  const cached = [];
  if (existsSync(cache)) {
    for (const entry of readdirSync(cache)) {
      if (!entry.startsWith("chromium")) continue;
      cached.push(path.join(cache, entry, "chrome-win64", "chrome.exe"));
      cached.push(path.join(cache, entry, "chrome-linux", "chrome"));
    }
  }
  const candidates = [
    process.env.CHROME_PATH,
    ...cached,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate));
}

const executablePath = findChromium();
if (!executablePath) {
  console.error("No Chromium-based browser found. Set CHROME_PATH or install one.");
  process.exit(2);
}

// The browser cannot fetch the extension cross-origin, so it is cached locally
// first and served from the probe's own origin.
const extension = await ensureParquetExtension("wasm_eh");

const probe = createProbeServer();
const port = await probe.listen();
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage();
const logs = [];
page.on("console", message => logs.push(`${message.type()}: ${message.text()}`));
page.on("pageerror", error => logs.push(`pageerror: ${error.message}`));
page.on("response", response => {
  if (response.status() >= 400) logs.push(`http ${response.status()}: ${response.url()}`);
});

let result;
try {
  await page.goto(`http://127.0.0.1:${port}/wasm`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__PROBE_RESULT !== undefined, undefined, { timeout: 180_000 });
  result = await page.evaluate(() => window.__PROBE_RESULT);
} catch (error) {
  console.error(`probe did not finish: ${String(error).slice(0, 400)}`);
  console.error(logs.join("\n"));
  await browser.close();
  await probe.close();
  process.exit(1);
}

console.log(JSON.stringify({ browser: executablePath, extension: path.relative(process.cwd(), extension), result, logs }, null, 2));

await browser.close();
await probe.close();
process.exit(result?.ok === true ? 0 : 1);
