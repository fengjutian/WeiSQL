/**
 * Cold-start measurement: download + instantiate DuckDB-Wasm with the HTTP cache
 * disabled, then open the fixture package over HTTP Range.
 *
 *   npm run bench:wasm-cold
 *
 * This is the "34 MB first load" number the docs otherwise lack. Single run,
 * local server, no CDN: a measurement, not a promise.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { createProbeServer } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

const fixture = path.resolve(HERE, "..", "..", "examples", "fixture");
const probe = createProbeServer(fixture);
const port = await probe.listen();
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext();
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Network.enable");
await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });

// Worker requests do not show up in the page's Resource Timing, so the sizes
// come from the HTTP responses the runner observes.
const downloads = [];
page.on("response", (response) => {
  const url = response.url();
  if (!/duckdb.*\.(wasm|js)/.test(url)) return;
  const headers = response.headers();
  const bytes = Number(headers["content-length"] ?? 0);
  downloads.push({ name: url.split("/").pop(), bytes });
});

try {
  await page.goto(`http://127.0.0.1:${port}/wasm-cold`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__COLD_RESULT !== undefined, undefined, { timeout: 180_000 });
  const result = await page.evaluate(() => window.__COLD_RESULT);
  if (result?.ok !== true) {
    console.error(JSON.stringify(result, null, 2));
    process.exitCode = 1;
  } else {
    console.log("| metric | result |");
    console.log("| --- | --- |");
    console.log(`| open() with cold cache | ${result.openMs} ms |`);
    for (const download of downloads) {
      console.log(`| ${download.name} | ${(download.bytes / (1024 * 1024)).toFixed(1)} MB |`);
    }
    const total = downloads.reduce((sum, item) => sum + item.bytes, 0);
    console.log(`| total fetched | ${(total / (1024 * 1024)).toFixed(1)} MB |`);
  }
} catch (error) {
  console.error(`cold-start benchmark failed: ${String(error).slice(0, 400)}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await probe.close();
}
