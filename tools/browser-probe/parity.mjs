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

import { ContainerReader, NodeFileResourceReader, open, validateManifest } from "@weisql/sdk";
import { createDuckDbAdapter } from "@weisql/duckdb-adapter";

import { INVALID_MANIFESTS, QUERIES, RAG_QUERY, SQL_QUERIES, SQL_STREAM_QUERIES, TEXT_INDEX, TEXT_QUERIES, summarizeError, summarizeHits, summarizeRag, summarizeSqlRows, summarizeTextHits } from "./parity-queries.mjs";
import { ensureParquetExtension } from "../fetch-duckdb-wasm-extension.mjs";
import { prepareProbePackage } from "./prepare-package.mjs";
import { createProbeServer } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DISTANCE_TOLERANCE = 1e-6;
const SCORE_TOLERANCE = 1e-9;

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

async function runNode(packageDirectory, containerPath) {
  const manifest = JSON.parse(await readFile(path.join(packageDirectory, "manifest.json"), "utf8"));
  const reader = new NodeFileResourceReader({ rootDirectory: packageDirectory });
  const db = await open({ manifest, resourceReader: reader, verifyChecksums: "all", sqlAdapter: createDuckDbAdapter() });
  const queries = [];
  for (const query of QUERIES) {
    try {
      const hits = await db.vector.search("document_embeddings", new Float32Array(query.vector), { topK: query.topK });
      queries.push({ name: query.name, ok: true, ...summarizeHits(hits) });
    } catch (error) {
      queries.push({ name: query.name, ok: false, error: summarizeError(error) });
    }
  }

  const textQueries = [];
  for (const query of TEXT_QUERIES) {
    try {
      const hits = await db.text.search(TEXT_INDEX, query.query, { topK: query.topK });
      textQueries.push({ name: query.name, ok: true, ...summarizeTextHits(hits) });
    } catch (error) {
      textQueries.push({ name: query.name, ok: false, error: summarizeError(error) });
    }
  }

  let rag;
  try {
    rag = { ok: true, ...summarizeRag(await db.rag.search({ text: { name: TEXT_INDEX, query: RAG_QUERY.query }, topK: RAG_QUERY.topK, maxCharacters: RAG_QUERY.maxCharacters })) };
  } catch (error) {
    rag = { ok: false, error: summarizeError(error) };
  }

  const sql = [];
  for (const query of SQL_QUERIES) {
    try {
      sql.push({ name: query.name, ok: true, rows: summarizeSqlRows(await db.sql(query.sql, query.params ?? [])) });
    } catch (error) {
      sql.push({ name: query.name, ok: false, error: summarizeError(error) });
    }
  }

  const sqlStream = [];
  for (const query of SQL_STREAM_QUERIES) {
    try {
      const options = query.abort === true ? { signal: AbortSignal.abort() } : undefined;
      const rows = [];
      for await (const row of await db.sqlStream(query.sql, query.params ?? [], options)) rows.push(row);
      sqlStream.push({ name: query.name, ok: true, rows: summarizeSqlRows(rows) });
    } catch (error) {
      sqlStream.push({ name: query.name, ok: false, error: summarizeError(error) });
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

  const containerReader = new ContainerReader(new Uint8Array(await readFile(containerPath)));
  const containerManifest = JSON.parse(new TextDecoder().decode(await containerReader.read("manifest.json")));
  const digests = (await containerReader.verify()).length;
  const containerDb = await open({ manifest: containerManifest, resourceReader: containerReader, verifyChecksums: "all" });
  const containerVector = summarizeHits(await containerDb.vector.search("document_embeddings", new Float32Array([1, 0]), { topK: 2 }));
  const containerText = summarizeTextHits(await containerDb.text.search(TEXT_INDEX, "dna", { topK: 2 }));
  await containerDb.close();

  return { environment: "node", queries, textQueries, rag, sql, sqlStream, invalid, container: { digests, vector: containerVector, text: containerText } };
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

const executablePath = findChromium();
if (!executablePath) {
  console.error("No Chromium-based browser found. Set CHROME_PATH or install one.");
  process.exit(2);
}

// Both environments must read identical bytes, including the derived text index
// and the packed container, so the package is built once and served to both.
const probePackage = await prepareProbePackage();
// The browser adapter loads parquet from this origin (extensions.duckdb.org
// sends no CORS headers).
await ensureParquetExtension("wasm_eh");
const nodeResult = await runNode(probePackage.packageDirectory, probePackage.containerPath);
const probe = createProbeServer(probePackage.packageDirectory, probePackage.containerPath);
const port = await probe.listen();
let browserResult;
try {
  browserResult = await runBrowser(port, executablePath);
} finally {
  await probe.close();
  await probePackage.cleanup();
}

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

for (const [index, query] of TEXT_QUERIES.entries()) {
  const left = nodeResult.textQueries[index];
  const right = browserResult.textQueries[index];
  check(`${query.name} status`, left.ok === right.ok, `node ok=${left.ok} browser ok=${right.ok}`);
  if (left.ok && right.ok) {
    check(`${query.name} ids`, JSON.stringify(left.ids) === JSON.stringify(right.ids), `${JSON.stringify(left.ids)} vs ${JSON.stringify(right.ids)}`);
    check(`${query.name} rows`, JSON.stringify(left.rows) === JSON.stringify(right.rows), `${JSON.stringify(left.rows)} vs ${JSON.stringify(right.rows)}`);
    check(`${query.name} backend`, left.backend === right.backend, `${left.backend} vs ${right.backend}`);
    const scoreMismatch = left.scores.find((value, position) => Math.abs(value - right.scores[position]) > SCORE_TOLERANCE);
    check(`${query.name} scores`, scoreMismatch === undefined, `${JSON.stringify(left.scores)} vs ${JSON.stringify(right.scores)}`);
  } else if (!left.ok && !right.ok) {
    check(`${query.name} error code`, left.error.code === right.error.code, `${left.error.code} vs ${right.error.code}`);
  }
  rows.push({
    query: query.name,
    node: left.ok ? left.ids.join(",") || "(none)" : `error:${left.error.code}`,
    browser: right.ok ? right.ids.join(",") || "(none)" : `error:${right.error.code}`,
    match: failures.filter(failure => failure.startsWith(`${query.name} `)).length === 0,
  });
}

check("rag status", nodeResult.rag.ok === browserResult.rag.ok, `node ok=${nodeResult.rag.ok} browser ok=${browserResult.rag.ok}`);
if (nodeResult.rag.ok && browserResult.rag.ok) {
  for (const field of ["ids", "texts", "ranks", "truncated", "usedCharacters", "droppedHits"]) {
    check(`rag ${field}`, JSON.stringify(nodeResult.rag[field]) === JSON.stringify(browserResult.rag[field]),
      `${JSON.stringify(nodeResult.rag[field])} vs ${JSON.stringify(browserResult.rag[field])}`);
  }
}

check("container digest count", nodeResult.container.digests === browserResult.container.digests,
  `${nodeResult.container.digests} vs ${browserResult.container.digests}`);
check("container digests clean", nodeResult.container.digests === 0 && browserResult.container.digests === 0,
  `${nodeResult.container.digests} vs ${browserResult.container.digests}`);
for (const kind of ["vector", "text"]) {
  const left = nodeResult.container[kind];
  const right = browserResult.container[kind];
  check(`container ${kind} ids`, JSON.stringify(left.ids) === JSON.stringify(right.ids), `${JSON.stringify(left.ids)} vs ${JSON.stringify(right.ids)}`);
  check(`container ${kind} rows`, JSON.stringify(left.rows) === JSON.stringify(right.rows), `${JSON.stringify(left.rows)} vs ${JSON.stringify(right.rows)}`);
}

// SQL parity is limited to the queries both adapters can answer (JSON scalar
// parameters, read-only) plus the error codes they must agree on.
const sqlRows = [];
for (const [index, query] of SQL_QUERIES.entries()) {
  const left = nodeResult.sql[index];
  const right = browserResult.sql[index];
  check(`sql "${query.name}" status`, left.ok === right.ok, `node ok=${left.ok} browser ok=${right.ok}`);
  if (left.ok && right.ok) {
    check(
      `sql "${query.name}" rows`,
      JSON.stringify(left.rows) === JSON.stringify(right.rows),
      `${JSON.stringify(left.rows)} vs ${JSON.stringify(right.rows)}`,
    );
  } else if (!left.ok && !right.ok) {
    check(`sql "${query.name}" error code`, left.error.code === right.error.code, `${left.error.code} vs ${right.error.code}`);
  }
  sqlRows.push({
    query: query.name,
    node: left.ok ? `${left.rows.length} row(s)` : `error:${left.error.code}`,
    browser: right.ok ? `${right.rows.length} row(s)` : `error:${right.error.code}`,
    match: failures.filter(failure => failure.startsWith(`sql "${query.name}" `)).length === 0,
  });
}

for (const [index, query] of SQL_STREAM_QUERIES.entries()) {
  const left = nodeResult.sqlStream[index];
  const right = browserResult.sqlStream[index];
  check(`sql stream "${query.name}" status`, left.ok === right.ok, `node ok=${left.ok} browser ok=${right.ok}`);
  if (left.ok && right.ok) {
    check(
      `sql stream "${query.name}" rows`,
      JSON.stringify(left.rows) === JSON.stringify(right.rows),
      `${JSON.stringify(left.rows)} vs ${JSON.stringify(right.rows)}`,
    );
  } else if (!left.ok && !right.ok) {
    check(`sql stream "${query.name}" error code`, left.error.code === right.error.code, `${left.error.code} vs ${right.error.code}`);
  }
  sqlRows.push({
    query: query.name,
    node: left.ok ? `${left.rows.length} row(s)` : `error:${left.error.code}`,
    browser: right.ok ? `${right.rows.length} row(s)` : `error:${right.error.code}`,
    match: failures.filter(failure => failure.startsWith(`sql stream "${query.name}" `)).length === 0,
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
console.log(`node:    ${nodeResult.queries.length} vector + ${nodeResult.textQueries.length} text + ${nodeResult.sql.length} SQL queries, ${nodeResult.invalid.length} manifest cases, 1 container`);
console.log(`browser: ${executablePath}`);
console.log("");
function printTable(tableRows) {
  const widths = {
    query: Math.max(5, ...tableRows.map(row => row.query.length)),
    node: Math.max(4, ...tableRows.map(row => row.node.length)),
    browser: Math.max(7, ...tableRows.map(row => row.browser.length)),
  };
  const pad = (value, width) => value.padEnd(width);
  console.log(pad("query", widths.query + 2) + pad("node", widths.node + 2) + pad("browser", widths.browser + 2) + "match");
  for (const row of tableRows) {
    console.log(pad(row.query, widths.query + 2) + pad(row.node, widths.node + 2) + pad(row.browser, widths.browser + 2) + (row.match ? "PASS" : "FAIL"));
  }
}
printTable(rows);
if (sqlRows.length > 0) {
  console.log("");
  console.log("SQL");
  printTable(sqlRows);
}
console.log("");
if (failures.length === 0) {
  console.log(`RESULT: ${QUERIES.length} vector + ${TEXT_QUERIES.length} text + ${SQL_QUERIES.length} SQL + ${SQL_STREAM_QUERIES.length} streaming SQL queries, RAG evidence, 1 container and ${INVALID_MANIFESTS.length} manifest cases match`);
  console.log(`        (distance tolerance ${DISTANCE_TOLERANCE}, BM25 score tolerance ${SCORE_TOLERANCE})`);
  process.exit(0);
}
console.log(`RESULT: ${failures.length} mismatch(es)`);
for (const failure of failures) console.log(`  - ${failure}`);
process.exit(1);
