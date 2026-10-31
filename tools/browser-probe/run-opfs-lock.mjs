/**
 * Cross-tab OPFS lock probe: one page holds the persistent database, a second
 * page opening the same package must fall back to memory, and a third page after
 * the first closes must get the cache back.
 *
 *   npm run probe:opfs-lock
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { ensureParquetExtension } from "../fetch-duckdb-wasm-extension.mjs";
import { createProbeServer } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(HERE, "..", "..", "examples", "fixture");

const executablePath = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean).find(candidate => existsSync(candidate));
if (!executablePath) {
  console.error("No Chromium-based browser found. Set CHROME_PATH or install one.");
  process.exit(2);
}

await ensureParquetExtension("wasm_eh");
const probe = createProbeServer(FIXTURE);
const port = await probe.listen();
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
// One context so both pages share the same OPFS partition and Web Locks scope;
// `browser.newPage()` would create isolated contexts and never contend.
const context = await browser.newContext();

async function openPage() {
  const page = await context.newPage();
  page.on("pageerror", error => console.error(`pageerror: ${error.message}`));
  await page.goto(`http://127.0.0.1:${port}/opfs-lock`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__OPFS_STATE !== undefined, undefined, { timeout: 120_000 });
  const state = await page.evaluate(() => window.__OPFS_STATE);
  return { page, state };
}

const first = await openPage();
const second = await openPage(0);
const secondState = second.state;

const firstHasOpfs = first.state.features?.includes("opfs") === true;
const secondHasOpfs = secondState.features?.includes("opfs") === true;

// Close the holders so a fresh page can acquire the lock (the lock is released
// when the document unloads).
await first.page.close();
await second.page.close();
const third = await openPage();
const thirdHasOpfs = third.state.features?.includes("opfs") === true;
await third.page.close();
await browser.close();
await probe.close();

const result = {
  ok: firstHasOpfs && !secondHasOpfs && thirdHasOpfs && first.state.rows === 3 && third.state.rows === 3,
  first: { features: first.state.features, rows: first.state.rows },
  second: { features: secondState.features, rows: secondState.rows },
  third: { features: third.state.features, rows: third.state.rows },
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
