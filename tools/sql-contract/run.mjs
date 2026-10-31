/**
 * Runs one SQL contract against both real adapters and reports every case.
 *
 *   npm run test:contract
 *
 * Node uses `@duckdb/node-api`; the browser adapter runs the same WASM build in
 * Node through the blocking bindings, which is the closest thing to the browser
 * without a Chromium dependency. Declared differences live in `cases.mjs`; an
 * undeclared difference fails this command.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { NodeFileResourceReader } from "@weisql/sdk";
import { createDuckDbAdapter } from "@weisql/duckdb-adapter";
import { createDuckDbWasmAdapter } from "@weisql/duckdb-wasm-adapter";

import { createWasmTestDatabase } from "../../packages/duckdb-wasm-adapter/test/helpers/wasm-database.mjs";
import { CONTRACT_CASES } from "./cases.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const FIXTURE = path.join(REPO_ROOT, "examples", "fixture");

const normalize = (value) => {
  if (typeof value === "bigint") return Number(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Uint8Array) return Array.from(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
};

const attempt = async (adapter, testCase) => {
  try {
    const options = testCase.abort === true
      ? { ...(testCase.options ?? {}), signal: AbortSignal.abort() }
      : testCase.options;
    if (testCase.stream === true) {
      const rows = [];
      const iterable = await adapter.stream(testCase.sql, testCase.params ?? [], options);
      for await (const row of iterable) rows.push(normalize(row));
      return { ok: true, rows };
    }
    const rows = await adapter.query(testCase.sql, testCase.params ?? [], options);
    return { ok: true, rows: normalize(rows) };
  } catch (error) {
    return { ok: false, code: error?.code ?? "NO_CODE" };
  }
};

const failures = [];
const check = (condition, message) => {
  if (!condition) failures.push(message);
};

const manifest = JSON.parse(await readFile(path.join(FIXTURE, "manifest.json"), "utf8"));

const nodeAdapter = createDuckDbAdapter();
const nodeReader = new NodeFileResourceReader({ rootDirectory: FIXTURE });
await nodeAdapter.open({ manifest, reader: nodeReader });

const database = await createWasmTestDatabase();
const wasmAdapter = createDuckDbWasmAdapter({ database });
const wasmReader = new NodeFileResourceReader({ rootDirectory: FIXTURE });
await wasmAdapter.open({ manifest, reader: wasmReader });

const rows = [];
for (const testCase of CONTRACT_CASES) {
  const nodeResult = await attempt(nodeAdapter, testCase);
  const wasmResult = await attempt(wasmAdapter, testCase);
  let outcome = "PASS";

  if (testCase.wasmError !== undefined) {
    check(nodeResult.ok, `${testCase.name}: Node should succeed but got ${nodeResult.code}`);
    check(
      !wasmResult.ok && wasmResult.code === testCase.wasmError,
      `${testCase.name}: Wasm should fail with ${testCase.wasmError} but got ${wasmResult.ok ? "rows" : wasmResult.code}`,
    );
    outcome = "DIFF*";
  } else if (testCase.expect?.error !== undefined) {
    check(nodeResult.ok === false && nodeResult.code === testCase.expect.error, `${testCase.name}: Node code ${nodeResult.code}`);
    check(wasmResult.ok === false && wasmResult.code === testCase.expect.error, `${testCase.name}: Wasm code ${wasmResult.code}`);
  } else {
    check(nodeResult.ok === wasmResult.ok, `${testCase.name}: status differs (node ${nodeResult.ok}, wasm ${wasmResult.ok})`);
    if (nodeResult.ok && wasmResult.ok) {
      check(
        JSON.stringify(nodeResult.rows) === JSON.stringify(wasmResult.rows),
        `${testCase.name}: rows differ: ${JSON.stringify(nodeResult.rows)} vs ${JSON.stringify(wasmResult.rows)}`,
      );
    } else if (!nodeResult.ok && !wasmResult.ok) {
      check(nodeResult.code === wasmResult.code, `${testCase.name}: codes differ ${nodeResult.code} vs ${wasmResult.code}`);
    }
  }

  rows.push({
    case: testCase.name,
    node: nodeResult.ok ? `${nodeResult.rows.length} row(s)` : `error:${nodeResult.code}`,
    wasm: wasmResult.ok ? `${wasmResult.rows.length} row(s)` : `error:${wasmResult.code}`,
    outcome: failures.some(failure => failure.startsWith(`${testCase.name}:`)) ? "FAIL" : outcome,
  });
}

// Lifecycle: close is idempotent and a closed adapter refuses queries.
for (const [label, adapter] of [["node", nodeAdapter], ["wasm", wasmAdapter]]) {
  await adapter.close();
  await adapter.close();
  try {
    await adapter.query("select 1");
    check(false, `${label}: query after close should fail`);
  } catch (error) {
    check(error?.code === "DATABASE_CLOSED", `${label}: expected DATABASE_CLOSED, got ${error?.code}`);
  }
  rows.push({ case: `close() then query (${label})`, node: label === "node" ? "DATABASE_CLOSED" : "", wasm: label === "wasm" ? "DATABASE_CLOSED" : "", outcome: "PASS" });
}

await nodeReader.close();
await wasmReader.close();
await database.terminate();

const widths = {
  name: Math.max(6, ...rows.map(row => row.case.length)),
  node: Math.max(4, ...rows.map(row => row.node.length)),
  wasm: Math.max(4, ...rows.map(row => row.wasm.length)),
};
const pad = (value, width) => value.padEnd(width);
console.log(pad("case", widths.name + 2) + pad("node", widths.node + 2) + pad("wasm", widths.wasm + 2) + "result");
for (const row of rows) {
  console.log(pad(row.case, widths.name + 2) + pad(row.node, widths.node + 2) + pad(row.wasm, widths.wasm + 2) + row.outcome);
}
console.log("");
console.log("DIFF* = declared difference (see tools/sql-contract/cases.mjs)");

if (failures.length > 0) {
  console.error(`\n${failures.length} contract failure(s):`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log(`RESULT: ${CONTRACT_CASES.length} SQL cases + lifecycle match across both adapters`);
