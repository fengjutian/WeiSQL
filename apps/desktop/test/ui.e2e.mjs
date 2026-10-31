/**
 * End-to-end check of the desktop UI in the browser preview.
 *
 *   npm run test:e2e
 *
 * The Tauri IPC layer is covered by the Rust unit tests; this test drives the
 * same UI, SDK runtime and DuckDB-Wasm adapter against the bundled sample
 * package, so a broken query path fails here instead of only in the app.
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, "..");
const REPO = path.resolve(APP, "..", "..");
const PORT = Number(process.env.PORT ?? 4174);
const URL = `http://127.0.0.1:${PORT}/`;

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

async function waitForServer(url, timeoutMs = 30_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The preview server is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`preview server did not start at ${url}`);
}

const executablePath = findChromium();
if (!executablePath) {
  console.error("No Chromium-based browser found. Set CHROME_PATH or install one.");
  process.exit(2);
}

const vite = path.join(REPO, "node_modules", "vite", "bin", "vite.js");
const server = spawn(process.execPath, [vite, "preview", "--host", "127.0.0.1", "--port", String(PORT), "--strictPort"], {
  cwd: APP,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.setEncoding("utf8").on("data", chunk => { serverLog += chunk; });
server.stderr.setEncoding("utf8").on("data", chunk => { serverLog += chunk; });

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

let browser;
try {
  await waitForServer(URL);
  browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const consoleErrors = [];
  page.on("console", message => {
    if (message.type() === "error") consoleErrors.push(`${message.text()} @ ${message.location().url}`);
  });
  page.on("pageerror", error => consoleErrors.push(`pageerror: ${error.message}`));
  page.on("requestfailed", request => consoleErrors.push(`requestfailed: ${request.url()} ${request.failure()?.errorText ?? ""}`));
  page.on("response", response => {
    if (response.status() >= 400) consoleErrors.push(`http ${response.status()}: ${response.url()}`);
  });

  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__DESKTOP_STATE?.datasetId !== undefined, undefined, { timeout: 60_000 });

  const opened = await page.evaluate(() => window.__DESKTOP_STATE);
  check(opened?.datasetId === "demo-documents", `unexpected dataset: ${String(opened?.datasetId)}`);
  check((await page.textContent("#table-count"))?.includes("1 张表") === true, "table count was not rendered");

  // SQL: the first run loads DuckDB-Wasm and the parquet extension (a few seconds).
  await page.click('[data-tab="sql"]');
  await page.fill("#sql-query", "select count(*) as n from documents");
  await page.click("#sql-run");
  await page.waitForFunction(() => typeof window.__DESKTOP_STATE?.sqlRows === "number", undefined, { timeout: 120_000 });
  const sqlRows = await page.evaluate(() => window.__DESKTOP_STATE?.sqlRows);
  const countText = await page.textContent("#sql-table tbody tr td");
  check(sqlRows === 1, `expected one SQL row, got ${String(sqlRows)}`);
  check(countText?.trim() === "3", `expected count 3, got ${String(countText)}`);

  // Vector: presets load the first three embeddings from the package.
  await page.click('[data-tab="vector"]');
  await page.click("#vector-run");
  await page.waitForFunction(() => Array.isArray(window.__DESKTOP_STATE?.vectorIds), undefined, { timeout: 30_000 });
  const vectorIds = await page.evaluate(() => window.__DESKTOP_STATE?.vectorIds);
  check(vectorIds?.length === 3, `expected 3 vector hits, got ${String(vectorIds?.length)}`);

  // Full text: the bundled sample has a generated BM25 index over `title`.
  await page.click('[data-tab="text"]');
  await page.fill("#text-query", "dna");
  await page.click("#text-run");
  await page.waitForFunction(() => Array.isArray(window.__DESKTOP_STATE?.textIds), undefined, { timeout: 30_000 });
  const textIds = await page.evaluate(() => window.__DESKTOP_STATE?.textIds);
  check(textIds?.includes("doc-001") === true, `expected doc-001 in text hits, got ${JSON.stringify(textIds)}`);

  await page.click('[data-tab="overview"]');
  await mkdir(path.join(REPO, "docs", "assets"), { recursive: true });
  await page.screenshot({ path: path.join(REPO, "docs", "assets", "desktop-client.png"), fullPage: false });

  const relevantErrors = consoleErrors.filter(message => !message.includes("favicon"));
  check(relevantErrors.length === 0, `console errors: ${relevantErrors.join(" | ").slice(0, 400)}`);

  if (failures.length > 0) {
    console.error(`E2E failed:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
  } else {
    console.log("E2E passed: sample package, SQL, vector search and full-text search.");
  }
} catch (error) {
  console.error(`E2E error: ${String(error)}\n--- preview output ---\n${serverLog.slice(-2000)}`);
  process.exitCode = 1;
} finally {
  await browser?.close();
  server.kill();
}
