/**
 * Drives the playground in a real Chromium and asserts the rendered results.
 *
 *   npm run probe:playground
 */
import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";

import { ensureParquetExtension } from "../fetch-duckdb-wasm-extension.mjs";
import { createProbeServer } from "./server.mjs";
import { prepareProbePackage } from "./prepare-package.mjs";

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

const probePackage = await prepareProbePackage();
// The playground's SQL panel loads the parquet extension from this origin.
await ensureParquetExtension("wasm_eh");
const probe = createProbeServer(probePackage.packageDirectory, probePackage.containerPath);
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
  await probePackage.cleanup();
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

// Full-text: typing a query must render BM25 hits for the same package.
try {
  await page.fill("#text-query", "dna");
  await page.click("#text-search");
  await page.waitForFunction(() => (window.__PLAYGROUND_STATE?.textIds ?? []).length > 0, undefined, { timeout: 20_000 });
} catch (error) {
  await fail(`text search interaction failed: ${String(error).slice(0, 300)}`);
}

// RAG: the assembled evidence must carry document text, not just ids.
try {
  await page.click("#rag");
  await page.waitForFunction(() => (window.__PLAYGROUND_STATE?.ragTexts ?? []).length > 0, undefined, { timeout: 20_000 });
} catch (error) {
  await fail(`RAG interaction failed: ${String(error).slice(0, 300)}`);
}

const textState = await page.evaluate(() => window.__PLAYGROUND_STATE);
if (!textState.textIds.includes("doc-001")) {
  await fail(`text search did not return doc-001: ${JSON.stringify(textState.textIds)}`);
}
const textRows = await page.locator("#text-results tr").count();
const ragRows = await page.locator("#rag-evidence li").count();

// Switching to the single-file container must produce the same results from the
// same bytes, with the whole container fetched up front.
try {
  await page.click("#mode-container");
  await page.waitForFunction(
    () => window.__PLAYGROUND_STATE?.mode === "container" && (window.__PLAYGROUND_STATE?.ids ?? []).length > 0,
    undefined,
    { timeout: 30_000 },
  );
} catch (error) {
  await fail(`container mode switch failed: ${String(error).slice(0, 300)}`);
}

const containerState = await page.evaluate(() => window.__PLAYGROUND_STATE);
if (containerState.ids.join(",") !== "doc-001,doc-002,doc-003") {
  await fail(`container mode results were ${JSON.stringify(containerState.ids)}`);
}
if (!(containerState.loadedBytes > 0)) {
  await fail(`container mode did not report loaded bytes: ${JSON.stringify(containerState.loadedBytes)}`);
}
if (!containerState.textIds.includes("doc-001")) {
  await fail(`container mode text search failed: ${JSON.stringify(containerState.textIds)}`);
}

// Streaming container: only the header and the files a query needs are fetched.
try {
  await page.click("#mode-streaming");
  await page.waitForFunction(
    () => window.__PLAYGROUND_STATE?.mode === "streaming" && (window.__PLAYGROUND_STATE?.ids ?? []).length > 0,
    undefined,
    { timeout: 30_000 },
  );
} catch (error) {
  await fail(`streaming mode switch failed: ${String(error).slice(0, 300)}`);
}

const streamingState = await page.evaluate(() => window.__PLAYGROUND_STATE);
if (streamingState.ids.join(",") !== "doc-001,doc-002,doc-003") {
  await fail(`streaming mode results were ${JSON.stringify(streamingState.ids)}`);
}
if (!streamingState.textIds.includes("doc-001")) {
  await fail(`streaming mode text search failed: ${JSON.stringify(streamingState.textIds)}`);
}

// Browser SQL: the same package must answer a real DuckDB-Wasm query.
try {
  await page.click("#sql-run");
  await page.waitForFunction(() => (window.__PLAYGROUND_STATE?.sqlIds ?? []).length === 3, undefined, { timeout: 120_000 });
} catch (error) {
  await fail(`SQL interaction failed: ${String(error).slice(0, 300)}\n${await page.locator("#sql-status").innerText()}`);
}

const sqlState = await page.evaluate(() => window.__PLAYGROUND_STATE);
if (sqlState.sqlIds.join(",") !== "doc-001,doc-002,doc-003") {
  await fail(`SQL results were ${JSON.stringify(sqlState.sqlIds)}`);
}
const sqlRows = await page.locator("#sql-results tr").count();
const sqlStatusBefore = await page.locator("#sql-status").innerText();

// Streaming SQL: the same query through sqlStream() must render the same rows.
try {
  await page.check("#sql-stream");
  await page.click("#sql-run");
  await page.waitForFunction(
    () => window.__PLAYGROUND_STATE?.sqlStreaming === true && (window.__PLAYGROUND_STATE?.sqlIds ?? []).length === 3,
    undefined,
    { timeout: 60_000 },
  );
  await page.uncheck("#sql-stream");
} catch (error) {
  await fail(`streaming SQL failed: ${String(error).slice(0, 300)}\n${await page.locator("#sql-status").innerText()}`);
}
const streamingSqlState = await page.evaluate(() => window.__PLAYGROUND_STATE);
if (streamingSqlState.sqlIds.join(",") !== "doc-001,doc-002,doc-003") {
  await fail(`streaming SQL results were ${JSON.stringify(streamingSqlState.sqlIds)}`);
}
const sqlStatus = await page.locator("#sql-status").innerText();
if (!sqlStatus.includes("流式")) {
  await fail(`streaming SQL status did not mention 流式: ${sqlStatus}`);
}

// Row budget: two rows requested against a three-row result must fail loudly
// instead of truncating, on both the array and the streaming path.
try {
  await page.fill("#sql-max-rows", "2");
  for (const streaming of [false, true]) {
    if (streaming) await page.check("#sql-stream");
    else await page.uncheck("#sql-stream");
    await page.evaluate(() => { document.querySelector("#error").textContent = ""; });
    await page.click("#sql-run");
    await page.waitForFunction(
      () => (document.querySelector("#error")?.textContent ?? "").includes("上限"),
      undefined,
      { timeout: 60_000 },
    );
    const errorText = await page.locator("#error").innerText();
    if (!errorText.includes("INVALID_ARGUMENT")) await fail(`row budget error was: ${errorText}`);
    const rendered = await page.locator("#sql-results tr").count();
    if (rendered !== 0) await fail(`row budget failure still rendered ${rendered} row(s)`);
  }
  await page.fill("#sql-max-rows", "");
  await page.uncheck("#sql-stream");
} catch (error) {
  await fail(`row budget check failed: ${String(error).slice(0, 300)}\n${await page.locator("#error").innerText()}`);
}

// Filtered vector search: the same Runtime now has a SQL engine, so the
// exact-filter-first strategy must run in the browser.
try {
  await page.selectOption("#filter-category", "genetics");
  await page.click("#search");
  await page.waitForFunction(
    () => window.__PLAYGROUND_STATE?.filterCategory === "genetics" && (window.__PLAYGROUND_STATE?.ids ?? []).length === 2,
    undefined,
    { timeout: 60_000 },
  );
} catch (error) {
  await fail(`filtered search failed: ${String(error).slice(0, 300)}\n${await page.locator("#error").innerText()}`);
}
const filterState = await page.evaluate(() => window.__PLAYGROUND_STATE);
if (filterState.ids.join(",") !== "doc-001,doc-002") {
  await fail(`filtered results were ${JSON.stringify(filterState.ids)}`);
}
const filterDiagnostics = await page.locator("#diagnostics").innerText();

console.log(JSON.stringify({
  browser: executablePath,
  initial,
  afterPreset,
  renderedRows,
  diagnostics: diagnostics.split("\n").filter(Boolean),
  textIds: textState.textIds,
  textScores: textState.textScores,
  textRows,
  ragIds: textState.ragIds,
  ragTexts: textState.ragTexts,
  ragRows,
  container: { mode: containerState.mode, ids: containerState.ids, loadedBytes: containerState.loadedBytes, textIds: containerState.textIds },
  streaming: { mode: streamingState.mode, ids: streamingState.ids, textIds: streamingState.textIds },
  sql: { ids: sqlState.sqlIds, rows: sqlRows, status: sqlStatusBefore },
  sqlStream: { ids: streamingSqlState.sqlIds, status: sqlStatus },
  filter: { ids: filterState.ids, diagnostics: filterDiagnostics.split("\n").filter(Boolean) },
}, null, 2));

await browser.close();
await probe.close();
await probePackage.cleanup();
process.exit(0);
