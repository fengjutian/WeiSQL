import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { DuckDBInstance } from "@duckdb/node-api";

import { NodeFileResourceReader, buildPackage, open } from "@weisql/sdk";
import { createDuckDbAdapter } from "@weisql/duckdb-adapter";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = path.join(REPO_ROOT, "examples", "fixture");

async function fixtureManifest() {
  return JSON.parse(await readFile(path.join(FIXTURE, "manifest.json"), "utf8"));
}

/** Opens the adapter directly against the example package. */
async function openAdapter(t, options = {}) {
  const manifest = await fixtureManifest();
  const reader = new NodeFileResourceReader({ rootDirectory: FIXTURE });
  const adapter = createDuckDbAdapter(options);
  t.after(async () => {
    await adapter.close().catch(() => undefined);
    await reader.close().catch(() => undefined);
  });
  await adapter.open({ manifest, reader });
  return { adapter, manifest, reader };
}

async function duckdbTempDirectories() {
  const entries = await readdir(tmpdir()).catch(() => []);
  return entries.filter(name => name.startsWith("weisql-duckdb-"));
}

/** Asserts rejection with one of several stable codes (policy rejections are code-dependent). */
async function rejectsWithCode(promise, codes, label) {
  const expected = Array.isArray(codes) ? codes : [codes];
  try {
    await promise;
  } catch (error) {
    assert.ok(expected.includes(error.code), `${label ?? "operation"}: expected ${expected.join("|")}, got ${error.code} (${error.message})`);
    return error;
  }
  assert.fail(`${label ?? "operation"}: expected rejection with ${expected.join("|")}`);
}

test("adapter reports honest capabilities before and after open", async t => {
  const adapter = createDuckDbAdapter();
  t.after(() => adapter.close().catch(() => undefined));
  assert.equal(adapter.capabilities.engine, "duckdb");
  assert.equal(adapter.capabilities.parameterBinding, true);
  assert.equal(adapter.capabilities.cancellation, "native");
  assert.equal(adapter.state, "CREATED");

  const manifest = await fixtureManifest();
  const reader = new NodeFileResourceReader({ rootDirectory: FIXTURE });
  t.after(() => reader.close().catch(() => undefined));
  await adapter.open({ manifest, reader });
  assert.equal(adapter.state, "READY");
  assert.match(adapter.capabilities.engineVersion ?? "", /^v?\d+\.\d+\.\d+/);
});

test("reads the Manifest tables through real SQL", async t => {
  const { adapter } = await openAdapter(t);
  const rows = await adapter.query("SELECT id, title, category FROM documents ORDER BY id");
  assert.deepEqual(rows, [
    { id: "doc-001", title: "DNA 结构", category: "genetics" },
    { id: "doc-002", title: "RNA 转录", category: "genetics" },
    { id: "doc-003", title: "细胞代谢", category: "metabolism" },
  ]);
});

test("parameter values are bound, never interpreted as SQL", async t => {
  const { adapter } = await openAdapter(t);
  assert.deepEqual(await adapter.query("SELECT id FROM documents WHERE id = ?", ["doc-002"]), [{ id: "doc-002" }]);
  assert.deepEqual(await adapter.query("SELECT id FROM documents WHERE id = ?", ["doc-001' OR '1'='1"]), []);
  assert.deepEqual(await adapter.query("SELECT title FROM documents WHERE category = ? ORDER BY id", ["genetics"]).then(rows => rows.map(row => row.title)), ["DNA 结构", "RNA 转录"]);
});

test("parameter arity and malformed SQL fail predictably", async t => {
  const { adapter } = await openAdapter(t);
  await assert.rejects(adapter.query("SELECT id FROM documents WHERE id = ?"), { code: "INVALID_ARGUMENT" });
  await assert.rejects(adapter.query("SELECT id FROM documents WHERE id = ?", ["a", "b"]), { code: "INVALID_ARGUMENT" });
  await assert.rejects(adapter.query("SELECT * FROM missing_table"), { code: "INVALID_ARGUMENT" });
  await assert.rejects(adapter.query("SELEKT 1"), { code: "INVALID_ARGUMENT" });
  await assert.rejects(adapter.query("   "), { code: "INVALID_ARGUMENT" });
});

test("maps DuckDB result types to the documented JavaScript types", async t => {
  const { adapter } = await openAdapter(t);
  const rows = await adapter.query(`SELECT
    9223372036854775807::BIGINT AS big,
    1::INTEGER AS int32,
    1.5::DOUBLE AS float64,
    TIMESTAMP '2024-01-01 12:00:00' AS ts,
    DATE '2024-01-01' AS dt,
    NULL::VARCHAR AS nothing,
    BLOB 'abc' AS blob,
    3.25::DECIMAL(10,2) AS dec,
    true AS flag`);
  const row = rows[0];
  assert.equal(row.big, 9223372036854775807n);
  assert.equal(row.int32, 1);
  assert.equal(row.float64, 1.5);
  assert.ok(row.ts instanceof Date);
  assert.equal(row.ts.toISOString(), "2024-01-01T12:00:00.000Z");
  assert.ok(row.dt instanceof Date);
  assert.equal(row.nothing, null);
  assert.ok(row.blob instanceof Uint8Array);
  assert.equal(new TextDecoder().decode(row.blob), "abc");
  assert.equal(row.dec, 3.25);
  assert.equal(row.flag, true);
});

test("maxRows bounds the result instead of truncating", async t => {
  const { adapter } = await openAdapter(t);
  assert.equal((await adapter.query("SELECT id FROM documents ORDER BY id")).length, 3);
  assert.equal((await adapter.query("SELECT id FROM documents ORDER BY id", [], { maxRows: 5 })).length, 3);

  await assert.rejects(
    adapter.query("SELECT id FROM documents ORDER BY id", [], { maxRows: 2 }),
    (error) => error.code === "INVALID_ARGUMENT" && error.details?.maxRows === 2,
  );
  // A CTE is still a SELECT, so it is wrapped and bounded by the engine.
  await assert.rejects(
    adapter.query("WITH x AS (SELECT id FROM documents) SELECT id FROM x", [], { maxRows: 2 }),
    (error) => error.code === "INVALID_ARGUMENT",
  );
  await assert.rejects(adapter.query("SELECT 1", [], { maxRows: 0 }), (error) => error.code === "INVALID_ARGUMENT");
  // The read-only boundary keeps precedence over the row budget.
  await assert.rejects(
    adapter.query("DELETE FROM documents", [], { maxRows: 5 }),
    (error) => error.code === "SQL_UNSUPPORTED",
  );
});

test("streams rows lazily and enforces maxRows across chunks", async t => {
  const { adapter } = await openAdapter(t);
  const ids = [];
  for await (const row of await adapter.stream("SELECT id FROM documents ORDER BY id")) ids.push(row.id);
  assert.deepEqual(ids, ["doc-001", "doc-002", "doc-003"]);

  const delivered = [];
  await assert.rejects(async () => {
    for await (const row of await adapter.stream("SELECT id FROM documents ORDER BY id", [], { maxRows: 2 })) {
      delivered.push(row.id);
    }
  }, (error) => error.code === "INVALID_ARGUMENT" && error.details?.maxRows === 2);
  // Streaming is hard-fail too: the caller sees the rows before the breach.
  assert.equal(delivered.length, 2);
  assert.deepEqual(delivered, ["doc-001", "doc-002"]);
});

test("stream cancellation rejects promptly instead of waiting for the next chunk", async t => {
  const { adapter } = await openAdapter(t);
  const controller = new AbortController();
  const started = performance.now();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(async () => {
    for await (const row of await adapter.stream(
      "SELECT sum(sqrt(range)) AS n FROM range(50000000)",
      [],
      { signal: controller.signal },
    )) {
      void row;
    }
  }, (error) => error.code === "QUERY_CANCELLED");
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1000, `stream cancellation took ${Math.round(elapsed)}ms`);
});

test("write, DDL, config and CALL statements are rejected as SQL_UNSUPPORTED", async t => {
  const { adapter } = await openAdapter(t);
  const statements = [
    "INSERT INTO documents VALUES ('x','y','z')",
    "UPDATE documents SET title = 'x'",
    "DELETE FROM documents",
    "DROP TABLE documents",
    "CREATE TABLE extra(a INT)",
    "ALTER TABLE documents ADD COLUMN extra INT",
    "COPY documents TO 'out.csv'",
    "SET threads=1",
    "PRAGMA disable_verification",
    "CALL pragma_version()",
    "select 1; drop table documents",
    "BEGIN TRANSACTION",
  ];
  for (const statement of statements) {
    await rejectsWithCode(adapter.query(statement), ["SQL_UNSUPPORTED", "INVALID_ARGUMENT"], statement);
  }
  const rows = await adapter.query("SELECT count(*)::INTEGER AS c FROM documents");
  assert.equal(rows[0].c, 3);
});

test("external file access is blocked after open", async t => {
  const { adapter } = await openAdapter(t);
  const target = path.join(REPO_ROOT, "examples", "source", "documents.parquet").replaceAll("\\", "/");
  await assert.rejects(adapter.query(`SELECT * FROM read_parquet('${target}')`), { code: "SQL_UNSUPPORTED" });
  await rejectsWithCode(adapter.query("SELECT * FROM read_csv_auto('/etc/passwd')"), ["SQL_UNSUPPORTED", "INVALID_ARGUMENT"], "read_csv_auto");
});

test("cancellation is native: pre-aborted and in-flight queries return QUERY_CANCELLED", async t => {
  const { adapter } = await openAdapter(t);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(adapter.query("SELECT 1", [], { signal: aborted.signal }), { code: "QUERY_CANCELLED" });

  const controller = new AbortController();
  const started = Date.now();
  const pending = adapter.query("SELECT sum(range) AS s FROM range(5000000000)", [], { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(pending, { code: "QUERY_CANCELLED" });
  assert.ok(Date.now() - started < 5000, "interrupt should return quickly");

  // The connection must stay usable after an interrupt.
  assert.deepEqual(await adapter.query("SELECT 1 AS ok"), [{ ok: 1 }]);
});

test("close is idempotent and later queries return DATABASE_CLOSED", async t => {
  const { adapter, reader } = await openAdapter(t);
  await adapter.close();
  assert.equal(adapter.state, "CLOSED");
  await adapter.close();
  await assert.rejects(adapter.query("SELECT 1"), { code: "DATABASE_CLOSED" });
  await reader.close();
});

test("repeated open is rejected", async t => {
  const { adapter, manifest, reader } = await openAdapter(t);
  await assert.rejects(adapter.open({ manifest, reader }), { code: "INVALID_ARGUMENT" });
});

test("open failures release resources and leave no temporary directories", async t => {
  const before = await duckdbTempDirectories();
  const manifest = await fixtureManifest();
  const adapter = createDuckDbAdapter();
  const failingReader = {
    async read() { throw new Error("network down"); },
    async readRange() { throw new Error("network down"); },
    async stat() { return { size: 832 }; },
    async close() {},
  };
  await rejectsWithCode(adapter.open({ manifest, reader: failingReader }), ["RESOURCE_NOT_FOUND", "INTERNAL_ERROR", "RESOURCE_READ_FAILED"], "open with failing reader");
  assert.equal(adapter.state, "FAILED");
  await assert.rejects(adapter.query("SELECT 1"), { code: "DATABASE_CLOSED" });
  const after = await duckdbTempDirectories();
  assert.deepEqual(after.filter(name => !before.includes(name)), []);
});

test("L4 schema verification rejects Manifest and Parquet mismatches", async t => {
  const manifest = await fixtureManifest();
  const reader = new NodeFileResourceReader({ rootDirectory: FIXTURE });
  t.after(() => reader.close().catch(() => undefined));

  const wrongType = structuredClone(manifest);
  wrongType.tables[0].columns[0].type = "int32";
  const typeAdapter = createDuckDbAdapter();
  await assert.rejects(typeAdapter.open({ manifest: wrongType, reader }), { code: "RESOURCE_INTEGRITY_FAILED" });
  assert.equal(typeAdapter.state, "FAILED");

  const wrongColumn = structuredClone(manifest);
  wrongColumn.tables[0].columns[0].name = "identifier";
  const columnAdapter = createDuckDbAdapter();
  await assert.rejects(columnAdapter.open({ manifest: wrongColumn, reader }), { code: "RESOURCE_INTEGRITY_FAILED" });

  const lenient = createDuckDbAdapter({ verifyTableSchema: false });
  t.after(() => lenient.close().catch(() => undefined));
  await lenient.open({ manifest: wrongType, reader });
  assert.equal(lenient.state, "READY");
});

test("declared byte length and budget are enforced before materialization", async t => {
  const manifest = await fixtureManifest();
  const reader = new NodeFileResourceReader({ rootDirectory: FIXTURE });
  t.after(() => reader.close().catch(() => undefined));

  const wrongBytes = structuredClone(manifest);
  wrongBytes.tables[0].file.bytes = 1024;
  const adapter = createDuckDbAdapter();
  await assert.rejects(adapter.open({ manifest: wrongBytes, reader }), { code: "RESOURCE_INTEGRITY_FAILED" });

  const budget = createDuckDbAdapter({ maxTableBytes: 64 });
  await assert.rejects(budget.open({ manifest, reader }), { code: "RESOURCE_INTEGRITY_FAILED" });
  assert.throws(() => createDuckDbAdapter({ maxTableBytes: 0 }), { code: "INVALID_ARGUMENT" });
});

test("package-wide budget is enforced before DuckDB is created", async t => {
  const manifest = await fixtureManifest();
  const reader = new NodeFileResourceReader({ rootDirectory: FIXTURE });
  t.after(() => reader.close().catch(() => undefined));

  const three = structuredClone(manifest);
  for (const name of ["documents_b", "documents_c"]) {
    three.tables.push({
      ...structuredClone(manifest.tables[0]),
      name,
      file: { ...structuredClone(manifest.tables[0].file), path: `data/${name}.parquet`, bytes: 200 * 1024 * 1024 },
    });
  }
  three.tables[0].file.bytes = 200 * 1024 * 1024;

  const adapter = createDuckDbAdapter();
  await assert.rejects(adapter.open({ manifest: three, reader }), (error) => {
    assert.equal(error.code, "RESOURCE_INTEGRITY_FAILED");
    assert.equal(error.details?.maxTotalTableBytes, 512 * 1024 * 1024);
    assert.equal(error.details?.bytes, 600 * 1024 * 1024);
    return true;
  });
  assert.equal(adapter.state, "FAILED");

  const tight = createDuckDbAdapter({ maxTotalTableBytes: 100 });
  await assert.rejects(tight.open({ manifest, reader }), (error) => {
    assert.equal(error.code, "RESOURCE_INTEGRITY_FAILED");
    assert.equal(error.details?.maxTotalTableBytes, 100);
    return true;
  });
  assert.throws(() => createDuckDbAdapter({ maxTotalTableBytes: 0 }), { code: "INVALID_ARGUMENT" });
});

test("Runtime + DuckDB adapter run the documented SQL/vector end to end", async t => {
  const manifest = await fixtureManifest();
  const reader = new NodeFileResourceReader({ rootDirectory: FIXTURE });
  const adapter = createDuckDbAdapter();
  const db = await open({ manifest, resourceReader: reader, sqlAdapter: adapter, verifyChecksums: "all" });
  t.after(() => db.close().catch(() => undefined));

  assert.equal(db.state, "READY");
  assert.deepEqual(db.capabilities(), { sql: true, vectorExactSearch: true, vectorAnnSearch: false, hybridSearch: true, textSearch: false, fusionSearch: true, ragSearch: false, resourceRange: true });

  const rows = await db.sql("SELECT id, title FROM documents WHERE category = ? ORDER BY id", ["genetics"]);
  assert.deepEqual(rows, [
    { id: "doc-001", title: "DNA 结构" },
    { id: "doc-002", title: "RNA 转录" },
  ]);

  // Join SQL metadata with vector hits through the business ID.
  const hits = await db.vector.search("document_embeddings", [1, 0], { topK: 2 });
  const metadata = await db.sql("SELECT id, title FROM documents WHERE id = ?", [hits[0].id]);
  assert.deepEqual(metadata, [{ id: "doc-001", title: "DNA 结构" }]);

  await assert.rejects(db.sql("DELETE FROM documents"), { code: "SQL_UNSUPPORTED" });
  await db.close();
  assert.equal(db.state, "CLOSED");
  assert.equal(adapter.state, "CLOSED");
});

test("vector-first trades exactness for a bounded candidate window", async t => {
  const manifest = await fixtureManifest();
  const reader = new NodeFileResourceReader({ rootDirectory: FIXTURE });
  const db = await open({ manifest, resourceReader: reader, sqlAdapter: createDuckDbAdapter() });
  t.after(() => db.close().catch(() => undefined));

  // Default window (topK × 4) exceeds the 3-row collection: exhaustive, so exact.
  const exhaustive = await db.vector.search("document_embeddings", [1, 0], {
    topK: 1,
    filter: { category: "metabolism" },
    strategy: "vector-first",
  });
  assert.deepEqual(exhaustive.map(hit => hit.id), ["doc-003"]);
  assert.equal(exhaustive[0].diagnostics.exact, true);
  assert.equal(exhaustive[0].diagnostics.candidatesScanned, 3);

  // A two-row window sees doc-001 and doc-002, both genetics: two hits, not exact.
  const bounded = await db.vector.search("document_embeddings", [1, 0], {
    topK: 2,
    filter: { category: "genetics" },
    strategy: "vector-first",
    vectorFirst: { initialCandidates: 2, expansionStep: 1, maxCandidates: 2 },
  });
  assert.deepEqual(bounded.map(hit => hit.id), ["doc-001", "doc-002"]);
  assert.equal(bounded[0].diagnostics.exact, false);
  assert.equal(bounded[0].diagnostics.candidatesScanned, 2);
  assert.equal(bounded[0].diagnostics.candidateCap, 2);

  // A one-row window never reaches the only matching row, while the exact
  // strategy still does.
  assert.deepEqual(await db.vector.search("document_embeddings", [1, 0], {
    topK: 1,
    filter: { category: "metabolism" },
    strategy: "vector-first",
    vectorFirst: { initialCandidates: 1, expansionStep: 1, maxCandidates: 1 },
  }), []);
  const exact = await db.vector.search("document_embeddings", [1, 0], { topK: 1, filter: { category: "metabolism" } });
  assert.deepEqual(exact.map(hit => hit.id), ["doc-003"]);
});

test("filter expressions support membership, inequality and ranges through real SQL", async t => {
  const manifest = await fixtureManifest();
  const reader = new NodeFileResourceReader({ rootDirectory: FIXTURE });
  const db = await open({ manifest, resourceReader: reader, sqlAdapter: createDuckDbAdapter() });
  t.after(() => db.close().catch(() => undefined));

  const membership = await db.vector.search("document_embeddings", [1, 0], { topK: 3, filter: { category: ["genetics", "metabolism"] } });
  assert.deepEqual(membership.map(hit => hit.id), ["doc-001", "doc-002", "doc-003"]);

  const inequality = await db.vector.search("document_embeddings", [1, 0], { topK: 3, filter: { category: { ne: "metabolism" } } });
  assert.deepEqual(inequality.map(hit => hit.id), ["doc-001", "doc-002"]);

  // String ranges are lexicographic; this proves the operator reaches SQL rather
  // than being silently ignored.
  const range = await db.vector.search("document_embeddings", [1, 0], { topK: 3, filter: { id: { gte: "doc-002" } } });
  assert.deepEqual(range.map(hit => hit.id), ["doc-002", "doc-003"]);

  await assert.rejects(db.vector.search("document_embeddings", [1, 0], { filter: { category: { in: [] } } }), { code: "INVALID_ARGUMENT" });
});

test("lazy table loading keeps memory bounded but re-enables file access", async t => {
  const manifest = await fixtureManifest();
  const reader = new NodeFileResourceReader({ rootDirectory: FIXTURE });
  t.after(() => reader.close().catch(() => undefined));

  const before = await duckdbTempDirectories();
  const adapter = createDuckDbAdapter({ tableLoading: "lazy" });
  await adapter.open({ manifest, reader });
  t.after(() => adapter.close().catch(() => undefined));

  assert.equal(adapter.tableLoading, "lazy");
  assert.ok(adapter.capabilities.supportedFeatures.includes("external-file-access-enabled"));
  assert.ok(!adapter.capabilities.supportedFeatures.includes("external-access-disabled"));

  // Same query results as the materialized mode.
  const rows = await adapter.query("SELECT id FROM documents ORDER BY id");
  assert.deepEqual(rows.map(row => row.id), ["doc-001", "doc-002", "doc-003"]);

  // Read-only is still enforced by statement classification.
  await assert.rejects(adapter.query("DELETE FROM documents"), { code: "SQL_UNSUPPORTED" });
  await assert.rejects(adapter.query("CREATE TABLE extra(a INT)"), { code: "SQL_UNSUPPORTED" });

  // The documented trade-off is real: with lazy views, external access must stay
  // open, so a SELECT over an arbitrary path is allowed.
  const external = path.join(REPO_ROOT, "examples", "source", "documents.parquet").replaceAll("\\", "/");
  const leaked = await adapter.query(`SELECT count(*)::INTEGER AS c FROM read_parquet('${external}')`);
  assert.equal(leaked[0].c, 3);

  await adapter.close();
  const after = await duckdbTempDirectories();
  assert.deepEqual(after.filter(name => !before.includes(name)), [], "lazy mode must delete its extracted files on close");
});

test("materialized mode reports the closed external-access boundary", async t => {
  const { adapter } = await openAdapter(t);
  assert.equal(adapter.tableLoading, "memory");
  assert.ok(adapter.capabilities.supportedFeatures.includes("external-access-disabled"));
  assert.ok(!adapter.capabilities.supportedFeatures.includes("external-file-access-enabled"));
});

test("rejects an unknown table loading mode", () => {
  assert.throws(() => createDuckDbAdapter({ tableLoading: "mmap" }), { code: "INVALID_ARGUMENT" });
});

test("exact-filter-first filters through real SQL before Top-K", async t => {
  const manifest = await fixtureManifest();
  const reader = new NodeFileResourceReader({ rootDirectory: FIXTURE });
  const db = await open({ manifest, resourceReader: reader, sqlAdapter: createDuckDbAdapter() });
  t.after(() => db.close().catch(() => undefined));
  assert.equal(db.capabilities().hybridSearch, true);

  const unfiltered = await db.vector.search("document_embeddings", [1, 0], { topK: 3 });
  assert.deepEqual(unfiltered.map(hit => hit.id), ["doc-001", "doc-002", "doc-003"]);
  assert.equal(unfiltered[0].diagnostics.strategy, undefined);

  const genetics = await db.vector.search("document_embeddings", [1, 0], { topK: 2, filter: { category: "genetics" } });
  assert.deepEqual(genetics.map(hit => hit.id), ["doc-001", "doc-002"]);
  assert.equal(genetics[0].diagnostics.strategy, "exact-filter-first");
  assert.equal(genetics[0].diagnostics.exact, true);
  assert.equal(genetics[0].diagnostics.filteredCandidates, 2);

  // doc-003 is the farthest hit overall; the filter must still surface it.
  const metabolic = await db.vector.search("document_embeddings", [1, 0], { topK: 1, filter: { category: "metabolism" } });
  assert.deepEqual(metabolic.map(hit => hit.id), ["doc-003"]);
  assert.ok(Math.abs(metabolic[0].distance - 1) < 1e-6);

  assert.deepEqual(await db.vector.search("document_embeddings", [1, 0], { filter: { category: "nope" } }), []);
  await assert.rejects(db.vector.search("document_embeddings", [1, 0], { filter: { missing: "x" } }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(db.vector.search("document_embeddings", [1, 0], { filter: { id: 3 } }), { code: "INVALID_ARGUMENT" });
});



test("json columns work through SQL while the filter DSL rejects them", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "weisql-json-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const parquet = path.join(directory, "documents.parquet");
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  await connection.run(
    `COPY (SELECT 'doc-001' AS id, '{"a":1,"b":[2]}' AS meta UNION ALL SELECT 'doc-002', '{"a":2}') ` +
    `TO '${parquet.replace(/\\/g, "/")}' (FORMAT PARQUET)`,
  );
  connection.closeSync?.();
  instance.closeSync?.();

  const report = await buildPackage({
    outputDirectory: path.join(directory, "package"),
    datasetId: "json-demo",
    tables: [{
      name: "documents",
      parquetPath: parquet,
      columns: [
        { name: "id", type: "string", nullable: false },
        { name: "meta", type: "json", nullable: false },
      ],
      primaryKey: ["id"],
      rowIds: ["doc-001", "doc-002"],
    }],
    vectorCollections: [{
      name: "document_embeddings",
      tableName: "documents",
      idColumn: "id",
      metric: "cosine",
      vectors: [[1, 0], [0, 1]],
      ids: ["doc-001", "doc-002"],
    }],
  });

  const reader = new NodeFileResourceReader({ rootDirectory: report.outputDirectory });
  const db = await open({ manifest: report.manifest, resourceReader: reader, sqlAdapter: createDuckDbAdapter() });
  t.after(() => db.close().catch(() => undefined));

  const rows = await db.sql("SELECT id FROM documents WHERE json_extract(meta, '$.a') = 1");
  assert.deepEqual(rows, [{ id: "doc-001" }]);

  await assert.rejects(
    db.vector.search("document_embeddings", [1, 0], { filter: { meta: "{}" } }),
    error => {
      assert.equal(error.code, "INVALID_ARGUMENT");
      assert.match(String(error.details?.hint), /db\.sql/);
      return true;
    },
  );
});
