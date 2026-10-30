import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildIdRowIndex, businessIdKey, compileEqualityFilter, normalizeBusinessId, open } from "../dist/index.js";

function floats(values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function offsets(values) {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setBigUint64(index * 8, BigInt(value), true));
  return bytes;
}

class MemoryReader {
  constructor(files) { this.files = files; }
  async read(path) { return this.files.get(path).slice(); }
  async readRange(path, range) { return this.files.get(path).slice(range.start, range.end); }
  async stat(path) { return { size: this.files.get(path).byteLength, supportsRange: true }; }
  async close() {}
}

async function fixturePackage() {
  const manifest = JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
  const idData = new TextEncoder().encode('{"row":0,"id":"doc-001"}\n{"row":1,"id":"doc-002"}\n{"row":2,"id":"doc-003"}\n');
  assert.equal(idData.byteLength, 75);
  const reader = new MemoryReader(new Map([
    ["vectors/embeddings.f32", floats([1, 0, 0.9, 0.1, 0, 1])],
    ["vectors/id-map.jsonl", idData],
    ["vectors/id-map.offsets", offsets([0, 25, 50])],
  ]));
  return { manifest, reader };
}

/** Minimal SqlAdapter that returns a fixed id projection for the filter query. */
function fakeSqlAdapter(rows, capture = []) {
  return {
    capabilities: { engine: "fake", parameterBinding: true, parquet: true, supportedFeatures: [], cancellation: "native" },
    async open() {},
    async query(statement, parameters = []) { capture.push({ statement, parameters }); return rows; },
    async close() {},
  };
}

test("exact-filter-first restricts the scan instead of trimming Top-K", async () => {
  const { manifest, reader } = await fixturePackage();
  const capture = [];
  // doc-003 is the farthest hit for [1, 0]; a filter must still return it as the
  // best (and only) match rather than dropping it after taking the global Top-K.
  const db = await open({ manifest, resourceReader: reader, sqlAdapter: fakeSqlAdapter([{ id: "doc-003" }], capture) });
  assert.equal(db.capabilities().hybridSearch, true);

  const hits = await db.vector.search("document_embeddings", [1, 0], { topK: 1, filter: { content: "x" } });
  assert.deepEqual(hits.map(hit => hit.id), ["doc-003"]);
  assert.ok(Math.abs(hits[0].distance - 1) < 1e-6);
  assert.equal(hits[0].row, 2);
  assert.equal(hits[0].diagnostics.exact, true);
  assert.equal(hits[0].diagnostics.strategy, "exact-filter-first");
  assert.equal(hits[0].diagnostics.filteredCandidates, 1);

  assert.equal(capture.length, 1);
  assert.match(capture[0].statement, /^SELECT "id" AS id FROM "documents" WHERE "content" = \?$/);
  assert.deepEqual(capture[0].parameters, ["x"]);
  await db.close();
});

test("vector-first reports an honest cap when the window cannot reach a match", async () => {
  const { manifest, reader } = await fixturePackage();
  // Only doc-003 (distance 1.0) matches, and the window is capped at one row.
  const db = await open({ manifest, resourceReader: reader, sqlAdapter: fakeSqlAdapter([{ id: "doc-003" }]) });
  const hits = await db.vector.search("document_embeddings", [1, 0], {
    topK: 1,
    filter: { content: "x" },
    strategy: "vector-first",
    vectorFirst: { initialCandidates: 1, expansionStep: 1, maxCandidates: 1 },
  });
  assert.deepEqual(hits, []);
  await db.close();
});

test("vector-first expands the window until it finds the match", async () => {
  const { manifest, reader } = await fixturePackage();
  const db = await open({ manifest, resourceReader: reader, sqlAdapter: fakeSqlAdapter([{ id: "doc-003" }]) });
  const hits = await db.vector.search("document_embeddings", [1, 0], {
    topK: 1,
    filter: { content: "x" },
    strategy: "vector-first",
    vectorFirst: { initialCandidates: 1, expansionStep: 1, maxCandidates: 8 },
  });
  assert.deepEqual(hits.map(hit => hit.id), ["doc-003"]);
  assert.equal(hits[0].diagnostics.strategy, "vector-first");
  assert.equal(hits[0].diagnostics.candidatesScanned, 3);
  assert.equal(hits[0].diagnostics.filteredCandidates, 1);
  // The window covered all three rows, so the result is exact by exhaustion.
  assert.equal(hits[0].diagnostics.exact, true);
  await db.close();
});

test("vector-first refuses to claim exactness while the window is closed", async () => {
  const { manifest, reader } = await fixturePackage();
  const db = await open({ manifest, resourceReader: reader, sqlAdapter: fakeSqlAdapter([{ id: "doc-002" }]) });
  const hits = await db.vector.search("document_embeddings", [1, 0], {
    topK: 1,
    filter: { content: "x" },
    strategy: "vector-first",
    vectorFirst: { initialCandidates: 1, expansionStep: 1, maxCandidates: 2 },
  });
  assert.deepEqual(hits.map(hit => hit.id), ["doc-002"]);
  assert.equal(hits[0].diagnostics.exact, false);
  assert.equal(hits[0].diagnostics.candidatesScanned, 2);
  await db.close();
});

test("hybrid option validation rejects missing filters and impossible caps", async () => {
  const { manifest, reader } = await fixturePackage();
  const db = await open({ manifest, resourceReader: reader, sqlAdapter: fakeSqlAdapter([]) });
  await assert.rejects(db.vector.search("document_embeddings", [1, 0], { strategy: "vector-first" }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(
    db.vector.search("document_embeddings", [1, 0], { topK: 3, filter: { content: "x" }, strategy: "vector-first", vectorFirst: { maxCandidates: 2 } }),
    { code: "INVALID_ARGUMENT" },
  );
  await assert.rejects(
    db.vector.search("document_embeddings", [1, 0], { filter: { content: "x" }, strategy: "vector-first", vectorFirst: { expansionStep: 0 } }),
    { code: "INVALID_ARGUMENT" },
  );
  await db.close();
});

test("filtered search returns fewer hits when the filter matches nothing", async () => {
  const { manifest, reader } = await fixturePackage();
  const db = await open({ manifest, resourceReader: reader, sqlAdapter: fakeSqlAdapter([]) });
  const hits = await db.vector.search("document_embeddings", [1, 0], { topK: 3, filter: { content: "missing" } });
  assert.deepEqual(hits, []);
  await db.close();
});

test("filtering without a SQL adapter still fails loudly", async () => {
  const { manifest, reader } = await fixturePackage();
  const db = await open({ manifest, resourceReader: reader });
  assert.equal(db.capabilities().hybridSearch, false);
  await assert.rejects(db.vector.search("document_embeddings", [1, 0], { filter: { category: "x" } }), { code: "SQL_UNSUPPORTED" });
  await db.close();
});

test("filter validation rejects undeclared columns and mismatched values", async () => {
  const { manifest, reader } = await fixturePackage();
  const db = await open({ manifest, resourceReader: reader, sqlAdapter: fakeSqlAdapter([]) });
  await assert.rejects(db.vector.search("document_embeddings", [1, 0], { filter: { unknown_column: "x" } }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(db.vector.search("document_embeddings", [1, 0], { filter: { id: 3 } }), { code: "INVALID_ARGUMENT" });  await db.close();
});

test("compileEqualityFilter quotes identifiers, binds values and encodes null", () => {
  const table = {
    name: "documents",
    file: { path: "data/documents.parquet", bytes: 1, sha256: "0".repeat(64) },
    format: "parquet",
    columns: [
      { name: "id", type: "string", nullable: false },
      { name: "category", type: "string", nullable: true },
      { name: "rank", type: "int32", nullable: true },
    ],
    primaryKey: ["id"],
  };
  const vector = { name: "v", tableName: "documents", idColumn: "id" };
  const compiled = compileEqualityFilter(table, vector, { category: "genetics", rank: 2 });
  assert.equal(compiled.sql, 'SELECT "id" AS id FROM "documents" WHERE "category" = ? AND "rank" = ?');
  assert.deepEqual(compiled.parameters, ["genetics", 2]);

  const nullFilter = compileEqualityFilter(table, vector, { category: null });
  assert.equal(nullFilter.sql, 'SELECT "id" AS id FROM "documents" WHERE "category" IS NULL');
  assert.deepEqual(nullFilter.parameters, []);

  assert.throws(() => compileEqualityFilter(table, vector, { nope: 1 }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => compileEqualityFilter(table, vector, { rank: "2" }), { code: "INVALID_ARGUMENT" });
});

test("business ID keys keep numbers and strings distinct", () => {
  assert.notEqual(businessIdKey(1), businessIdKey("1"));
  assert.equal(businessIdKey("doc-001"), "string:doc-001");
  assert.equal(normalizeBusinessId(7n, "documents"), 7);
  assert.throws(() => normalizeBusinessId(2n ** 63n, "documents"), { code: "RESOURCE_INTEGRITY_FAILED" });
  assert.throws(() => normalizeBusinessId(true, "documents"), { code: "RESOURCE_INTEGRITY_FAILED" });
});

test("buildIdRowIndex maps every business ID to its row", async () => {
  const reader = new MemoryReader(new Map([
    ["vectors/id-map.jsonl", new TextEncoder().encode('{"row":0,"id":"a"}\n{"row":1,"id":2}\n')],
    ["vectors/id-map.offsets", offsets([0, 19])],
  ]));
  const { IndexedIdMapReader } = await import("../dist/index.js");
  const idMap = new IndexedIdMapReader(reader, {
    dataPath: "vectors/id-map.jsonl",
    offsetsPath: "vectors/id-map.offsets",
    count: 2,
    dataBytes: 36,
    offsetsBytes: 16,
  });
  const index = await buildIdRowIndex(idMap, 2);
  assert.equal(index.get(businessIdKey("a")), 0);
  assert.equal(index.get(businessIdKey(2)), 1);
  assert.equal(index.size, 2);
  await idMap.close();
});
