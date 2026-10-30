/**
 * Cross-environment parity check: the same queries and Manifest mutations run in
 * Node.js and in a real Chromium, then every observable result is compared.
 *
 *   npm run probe:parity
 */
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { NodeFileResourceReader, open, validateManifest } from "@weisql/sdk";

import { INVALID_MANIFESTS, QUERIES, summarizeError, summarizeHits } from "./parity-queries.mjs";
import { createProbeServer } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const FIXTURE = path.join(REPO_ROOT, "examples", "fixture");
const DISTANCE_TOLERANCE = 1e-6;

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
  return [
    process.env.CHROME_PATH,
    ...cached,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean).find(candidate => existsSync(candidate));
}

async function runNode() {
  const manifest = JSON.parse(await readFile(path.join(FIXTURE, "manifest.json"), "utf8"));
  const reader = new NodeFileResourceReader({ rootDirectory: FIXTURE });
  const db = await open({ manifest, resourceReader: reader, verifyChecksums: "all" });
  const queries = [];
  for (const query of QUERIES) {
    try {
      const hits = await db.vector.search("document_embeddings", new Float32Array(query.vector), { topK: query.topK });
      queries.push({ name: query.name, ok: true, ...summarizeHits(hits) });
    } catch (error) {
      queries.push({ name: query.name, ok: false, error: summarizeError(error) });
    }
  }
  await db.close();

  const invalid = INVALID_MANIFESTS.map(({ name, mutate }) => {
    const copy = structuredClone(manifest);
    mutate(copy);
    try {
      validateManifest(copy);
      return { name, accepted: true };
    } catch (error) {
      return { name, accepted: false, code: error?.code ?? "NO_CODE" };
    }
  });
  return { environment: "node", queries, invalid };
}

async function runBrowser(port, executablePath) {
  const browser = await chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const page = await browser.newPage();
  const logs = [];
  page.on("console", message => logs.push(`${message.type()}: ${message.text()}`));
  page.on("pageerror", error => logs.push(`pageerror: ${error.message}`));
  page.on("response", response => { if (response.status() >= 400) logs.push(`http ${response.status()}: ${response.url()}`); });
  try {
    await page.goto(`http://127.0.0.1:${port}/parity/`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__PARITY_RESULT !== undefined, undefined, { timeout: 60_000 });
    return await page.evaluate(() => window.__PARITY_RESULT);
  } catch (error) {
    console.error(`browser parity page did not finish: ${String(error).slice(0, 300)}`);
    for (const line of logs) console.error(`  ${line}`);
    throw error;
  } finally {
    await browser.close();
  }
}

const failures = [];
const check = (label, condition, detail) => {
  if (!condition) failures.push(`${label}: ${detail}`);
};

const nodeResult = await runNode();
const executablePath = findChromium();
if (!executablePath) {
  console.error("No Chromium-based browser found. Set CHROME_PATH or install one.");
  process.exit(2);
}
const probe = createProbeServer();
const port = await probe.listen();
const browserResult = await runBrowser(port, executablePath);
await probe.close();

if (browserResult.fatal) {
  console.error(`browser run failed: ${browserResult.fatal}`);
  process.exit(1);
}

const rows = [];
for (const [index, query] of QUERIES.entries()) {
  const left = nodeResult.queries[index];
  const right = browserResult.queries[index];
  check(`${query.name} status`, left.ok === right.ok, `node ok=${left.ok} browser ok=${right.ok}`);
  if (left.ok && right.ok) {
    check(`${query.name} ids`, JSON.stringify(left.ids) === JSON.stringify(right.ids), `${JSON.stringify(left.ids)} vs ${JSON.stringify(right.ids)}`);
    check(`${query.name} rows`, JSON.stringify(left.rows) === JSON.stringify(right.rows), `${JSON.stringify(left.rows)} vs ${JSON.stringify(right.rows)}`);
    check(`${query.name} exact`, JSON.stringify(left.exact) === JSON.stringify(right.exact), `${JSON.stringify(left.exact)} vs ${JSON.stringify(right.exact)}`);
    check(`${query.name} backend`, left.backend === right.backend, `${left.backend} vs ${right.backend}`);
    const distanceMismatch = left.distances.find((value, position) => Math.abs(value - right.distances[position]) > DISTANCE_TOLERANCE);
    check(`${query.name} distances`, distanceMismatch === undefined, `${JSON.stringify(left.distances)} vs ${JSON.stringify(right.distances)}`);
  } else if (!left.ok && !right.ok) {
    check(`${query.name} error code`, left.error.code === right.error.code, `${left.error.code} vs ${right.error.code}`);
  }
  rows.push({
    query: query.name,
    node: left.ok ? left.ids.join(",") : `error:${left.error.code}`,
    browser: right.ok ? right.ids.join(",") : `error:${right.error.code}`,
    match: failures.filter(failure => failure.startsWith(`${query.name} `)).length === 0,
  });
}

for (const [index, invalid] of INVALID_MANIFESTS.entries()) {
  const left = nodeResult.invalid[index];
  const right = browserResult.invalid[index];
  check(`manifest "${invalid.name}" acceptance`, left.accepted === right.accepted, `${left.accepted} vs ${right.accepted}`);
  if (!left.accepted && !right.accepted) {
    check(`manifest "${invalid.name}" code`, left.code === right.code, `${left.code} vs ${right.code}`);
  }
}

console.log("ENVIRONMENT PARITY");
console.log(`node:    ${nodeResult.queries.length} queries, ${nodeResult.invalid.length} manifest cases`);
console.log(`browser: ${executablePath}`);
console.log("");
const widths = {
  query: Math.max(5, ...rows.map(row => row.query.length)),
  node: Math.max(4, ...rows.map(row => row.node.length)),
  browser: Math.max(7, ...rows.map(row => row.browser.length)),
};
const pad = (value, width) => value.padEnd(width);
console.log(pad("query", widths.query + 2) + pad("node", widths.node + 2) + pad("browser", widths.browser + 2) + "match");
for (const row of rows) {
  console.log(pad(row.query, widths.query + 2) + pad(row.node, widths.node + 2) + pad(row.browser, widths.browser + 2) + (row.match ? "PASS" : "FAIL"));
}
console.log("");
if (failures.length === 0) {
  console.log(`RESULT: ${rows.length} queries and ${INVALID_MANIFESTS.length} manifest cases match (distance tolerance ${DISTANCE_TOLERANCE})`);
  process.exit(0);
}
console.log(`RESULT: ${failures.length} mismatch(es)`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(1);
