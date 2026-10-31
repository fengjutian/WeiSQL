import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { NodeFileResourceReader } from "@weisql/sdk";

import { createDuckDbWasmAdapter } from "../dist/index.js";
import { createWasmTestDatabase } from "./helpers/wasm-database.mjs";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const FIXTURE = path.join(REPO_ROOT, "examples", "fixture");
const manifest = JSON.parse(readFileSync(path.join(FIXTURE, "manifest.json"), "utf8"));

async function withAdapter(run, options = {}) {
  const database = await createWasmTestDatabase();
  const adapter = createDuckDbWasmAdapter({ database, ...options });
  try {
    await adapter.open({ manifest, reader: new NodeFileResourceReader({ rootDirectory: FIXTURE }) });
    return await run(adapter);
  } finally {
    await adapter.close();
    await database.terminate();
  }
}

test("opens the fixture and answers a parameterised query", async () => {
  await withAdapter(async (adapter) => {
    const capabilities = adapter.capabilities;
    assert.equal(capabilities.engine, "duckdb-wasm");
    assert.equal(capabilities.parquet, true);
    assert.equal(capabilities.parameterBinding, true);
    assert.equal(capabilities.cancellation, "best-effort");
    assert.match(capabilities.engineVersion ?? "", /^v\d+\.\d+\.\d+/);
    assert.ok(capabilities.supportedFeatures.includes("external-access-disabled"));

    const rows = await adapter.query("SELECT id, title FROM documents ORDER BY id");
    assert.deepEqual(rows, [
      { id: "doc-001", title: "DNA 结构" },
      { id: "doc-002", title: "RNA 转录" },
      { id: "doc-003", title: "细胞代谢" },
    ]);

    const filtered = await adapter.query("SELECT id FROM documents WHERE category = ? ORDER BY id", ["genetics"]);
    assert.deepEqual(filtered, [{ id: "doc-001" }, { id: "doc-002" }]);
    const one = await adapter.query("SELECT title FROM documents WHERE id = ?", ["doc-003"]);
    assert.deepEqual(one, [{ title: "细胞代谢" }]);
  });
});

test("binds parameters instead of interpolating them", async () => {
  await withAdapter(async (adapter) => {
    const rows = await adapter.query("SELECT id FROM documents WHERE id = ?", ["' OR 1=1 --"]);
    assert.deepEqual(rows, []);
    const nulls = await adapter.query("SELECT ? IS NULL AS is_null", [null]);
    assert.deepEqual(nulls, [{ is_null: true }]);
  });
});

test("rejects statements outside the read-only allow-list", async () => {
  await withAdapter(async (adapter) => {
    await assert.rejects(adapter.query("DELETE FROM documents"), (error) => error.code === "SQL_UNSUPPORTED");
    await assert.rejects(adapter.query("CREATE TABLE x AS SELECT 1"), (error) => error.code === "SQL_UNSUPPORTED");
    await assert.rejects(adapter.query("SELECT 1; SELECT 2"), (error) => error.code === "SQL_UNSUPPORTED");
    const semicolon = await adapter.query("SELECT ';' AS semicolon");
    assert.deepEqual(semicolon, [{ semicolon: ";" }]);
  });
});

test("accepts read-only CTEs and still rejects write CTEs", async () => {
  await withAdapter(async (adapter) => {
    assert.ok(adapter.capabilities.supportedFeatures.includes("cte"));

    const rows = await adapter.query("WITH x AS (SELECT id FROM documents WHERE category = ?) SELECT id FROM x ORDER BY id", ["genetics"]);
    assert.deepEqual(rows, [{ id: "doc-001" }, { id: "doc-002" }]);

    const multiple = await adapter.query(
      "WITH a AS (SELECT 1 AS n), b AS (SELECT 2 AS n) SELECT a.n + b.n AS total FROM a, b",
    );
    assert.deepEqual(multiple, [{ total: 3 }]);

    const recursive = await adapter.query(
      "WITH RECURSIVE t(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM t WHERE n < 3) SELECT n FROM t ORDER BY n",
    );
    assert.deepEqual(recursive, [{ n: 1 }, { n: 2 }, { n: 3 }]);

    // Token offsets are UTF-8 bytes; a non-ASCII literal before a keyword must
    // not shift the classification.
    const chinese = await adapter.query("WITH x AS (SELECT '中' AS s) SELECT s FROM x");
    assert.deepEqual(chinese, [{ s: "中" }]);
    await assert.rejects(adapter.query("SELECT '中'; DELETE FROM documents"), (error) => error.code === "SQL_UNSUPPORTED");

    await assert.rejects(adapter.query("WITH x AS (SELECT 1) DELETE FROM documents"), (error) => error.code === "SQL_UNSUPPORTED");
    await assert.rejects(
      adapter.query("WITH x AS (SELECT 1) INSERT INTO documents SELECT * FROM documents"),
      (error) => error.code === "SQL_UNSUPPORTED",
    );
  });
});

test("rejects external file access after open()", async () => {
  await withAdapter(async (adapter) => {
    await assert.rejects(adapter.query("SELECT * FROM read_parquet('examples/fixture/data/documents.parquet')"), (error) =>
      ["SQL_UNSUPPORTED", "INTERNAL_ERROR"].includes(error.code),
    );
  });
});

test("rejects parameter types DuckDB-Wasm cannot bind", async () => {
  await withAdapter(async (adapter) => {
    await assert.rejects(adapter.query("SELECT ? AS value", [new Date(0)]), (error) => error.code === "INVALID_ARGUMENT");
    await assert.rejects(adapter.query("SELECT ? AS value", [new Uint8Array([1])]), (error) => error.code === "INVALID_ARGUMENT");
    await assert.rejects(adapter.query("SELECT ? AS value", [9007199254740993n]), (error) => error.code === "INVALID_ARGUMENT");
    assert.deepEqual(await adapter.query("SELECT ? AS value", [1n]), [{ value: 1 }]);
  });
});

test("maps engine values onto the public SQLValue shapes", async () => {
  await withAdapter(async (adapter) => {
    const rows = await adapter.query("SELECT 42 AS i, 1.5 AS f, true AS b, 'x' AS s, NULL AS z, count(*) AS n FROM documents");
    const [row] = rows;
    assert.equal(row.i, 42);
    // DECIMAL is cast to DOUBLE, matching the Node adapter's driver behaviour.
    assert.equal(typeof row.f, "number");
    assert.equal(row.f, 1.5);
    assert.equal(row.b, true);
    assert.equal(row.s, "x");
    assert.equal(row.z, null);
    // COUNT(*) is BIGINT and must stay a bigint, not a lossy number.
    assert.equal(typeof row.n, "bigint");
    assert.equal(row.n, 3n);
  });
});

test("rejects invalid SQL and pre-aborted queries with stable codes", async () => {
  await withAdapter(async (adapter) => {
    await assert.rejects(adapter.query("SELECT 1 +"), (error) => error.code === "INVALID_ARGUMENT");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      adapter.query("SELECT 1", [], { signal: controller.signal }),
      (error) => error.code === "QUERY_CANCELLED",
    );
  });
});

test("close() is idempotent and query() fails afterwards", async () => {
  const database = await createWasmTestDatabase();
  const adapter = createDuckDbWasmAdapter({ database });
  await adapter.open({ manifest, reader: new NodeFileResourceReader({ rootDirectory: FIXTURE }) });
  await adapter.close();
  await adapter.close();
  assert.equal(adapter.state, "CLOSED");
  await assert.rejects(adapter.query("SELECT 1"), (error) => error.code === "DATABASE_CLOSED");
  await database.terminate();
});

test("L4 mismatch between Manifest and Parquet fails open()", async () => {
  const broken = structuredClone(manifest);
  broken.tables[0].columns[0].type = "int32";
  const database = await createWasmTestDatabase();
  const adapter = createDuckDbWasmAdapter({ database });
  try {
    await assert.rejects(
      adapter.open({ manifest: broken, reader: new NodeFileResourceReader({ rootDirectory: FIXTURE }) }),
      (error) => error.code === "RESOURCE_INTEGRITY_FAILED",
    );
    assert.equal(adapter.state, "FAILED");
  } finally {
    await database.terminate();
  }
});

test("tables larger than maxTableBytes are rejected", async () => {
  const database = await createWasmTestDatabase();
  const adapter = createDuckDbWasmAdapter({ database, maxTableBytes: 128 });
  try {
    await assert.rejects(
      adapter.open({ manifest, reader: new NodeFileResourceReader({ rootDirectory: FIXTURE }) }),
      (error) => error.code === "RESOURCE_INTEGRITY_FAILED",
    );
  } finally {
    await database.terminate();
  }
});

test("requires bundles or an injected database", () => {
  assert.throws(() => createDuckDbWasmAdapter(), (error) => error.code === "INVALID_ARGUMENT");
  assert.throws(
    () => createDuckDbWasmAdapter({ bundles: { mainModule: "a", mainWorker: "b" }, extensionRepository: "file:///tmp" }),
    (error) => error.code === "INVALID_ARGUMENT",
  );
});
