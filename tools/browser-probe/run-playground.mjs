/**
 * Drives the playground in a real Chromium and asserts the rendered results.
 *
 *   npm run probe:playground
 */
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";

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

const probe = createProbeServer();
const port = await probe.listen();
const browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
const logs = [];
page.on("console", message => logs.push(`${message.type()}: ${message.text()}`));
page.on("pageerror", error => logs.push(`pageerror: ${error.message}`));

const fail = async (message) => {
  console.error(message);
  if (logs.length > 0) console.error(logs.join("\n"));
  await browser.close();
  await probe.close();
  process.exit(1);
};

try {
  await page.goto(`http://127.0.0.1:${port}/playground/`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__PLAYGROUND_STATE?.ok === true, undefined, { timeout: 60_000 });
} catch (error) {
  await fail(`playground did not become ready: ${String(error).slice(0, 400)}`);
}

const initial = await page.evaluate(() => window.__PLAYGROUND_STATE);
if (initial.ids.join(",") !== "doc-001,doc-002,doc-003") {
  await fail(`initial results were ${JSON.stringify(initial)}`);
}

// Selecting the third preset must move doc-003 to the top.
try {
  await page.locator("#presets button").nth(2).click();
  await page.waitForFunction(() => window.__PLAYGROUND_STATE?.ids?.[0] === "doc-003", undefined, { timeout: 20_000 });
} catch (error) {
  await fail(`preset interaction failed: ${String(error).slice(0, 300)}`);
}

const afterPreset = await page.evaluate(() => window.__PLAYGROUND_STATE);
const renderedRows = await page.locator("#results tr").count();
const diagnostics = await page.locator("#diagnostics").innerText();

console.log(JSON.stringify({
  browser: executablePath,
  initial,
  afterPreset,
  renderedRows,
  diagnostics: diagnostics.split("\n").filter(Boolean),
}, null, 2));

await browser.close();
await probe.close();
process.exit(0);
