import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { open, validateManifest } from "../dist/index.js";

const fixture = name => new URL(`../../../examples/manifest/${name}`, import.meta.url);
const readJson = async name => JSON.parse(await readFile(fixture(name), "utf8"));

test("accepts the valid minimal manifest", async () => {
  const manifest = validateManifest(await readJson("valid-minimal.json"));
  assert.equal(manifest.datasetId, "demo-docs");
});

test("rejects path traversal", async () => {
  const value = await readJson("invalid-traversal.json");
  assert.throws(() => validateManifest(value), error => {
    assert.equal(error.code, "MANIFEST_INVALID");
    assert.match(JSON.stringify(error.details), /safe package-relative path/);
    return true;
  });
});

test("rejects unsupported major versions", async () => {
  const value = await readJson("valid-minimal.json");
  value.formatVersion = "2.0.0";
  assert.throws(() => validateManifest(value), { code: "FORMAT_VERSION_UNSUPPORTED" });
});

test("rejects duplicate resource paths", async () => {
  const value = await readJson("valid-minimal.json");
  value.vectorCollections[0].data.path = value.tables[0].file.path;
  assert.throws(() => validateManifest(value), error => JSON.stringify(error.details).includes("duplicates resource"));
});

test("open loads and validates a manifest before returning a database", async () => {
  const value = await readJson("valid-minimal.json");
  const db = await open({ manifestUrl: "https://example.test/manifest.json", fetch: async () => new Response(JSON.stringify(value)) });
  assert.equal(db.manifest.format, "weisql");
  await db.close();
  await db.close();
  await assert.rejects(db.sql("select 1"), { code: "DATABASE_CLOSED" });
});

test("open rejects invalid JSON", async () => {
  await assert.rejects(open({ manifestUrl: "x", fetch: async () => new Response("{") }), { code: "MANIFEST_INVALID" });
});

test("vector input validation returns stable errors before adapter lookup", async () => {
  const value = await readJson("valid-minimal.json");
  const db = await open({ manifestUrl: "x", fetch: async () => new Response(JSON.stringify(value)) });
  await assert.rejects(db.vector.search("document_embeddings", [1, 0], { topK: 0 }), { code: "VECTOR_INVALID_VALUE" });
  await assert.rejects(db.vector.search("document_embeddings", [1]), { code: "VECTOR_DIMENSION_MISMATCH" });
  await assert.rejects(db.vector.search("document_embeddings", [1, Number.NaN]), { code: "VECTOR_INVALID_VALUE" });
  await assert.rejects(db.vector.search("document_embeddings", [1, 0]), { code: "INDEX_NOT_FOUND" });
});

test("validates frozen V1 cross-field constraints", async () => {
  const base = await readJson("valid-minimal.json");
  const cases = [
    value => { value.tables[0].columns.push({ ...value.tables[0].columns[0] }); },
    value => { value.tables[0].primaryKey = ["missing"]; },
    value => { value.tables[0].columns[0].nullable = true; },
    value => { value.datasetId = "_invalid"; },
    value => { value.tables[0].name = `t${"x".repeat(128)}`; },
    value => { value.vectorCollections[0].tableName = "missing"; },
    value => { value.vectorCollections[0].idColumn = "content"; },
    value => { value.vectorCollections[0].data.bytes = 23; },
    value => { value.vectorCollections[0].idMap.count = 2; },
    value => { value.vectorCollections[0].idMap.offsets.bytes = 16; },
    value => { value.vectorCollections[0].count = 1.5; },
    value => { value.vectorCollections[0].dimension = 65_537; },
    value => { value.vectorCollections[0].data.bytes = 1.5; },
    value => { value.vectorCollections[0].idMap = null; },
    value => { value.extra = true; },
  ];
  for (const mutate of cases) {
    const value = structuredClone(base); mutate(value);
    assert.throws(() => validateManifest(value), { code: "MANIFEST_INVALID" });
  }
});

test("accepts an empty vector collection with zero-byte data and offsets", async () => {
  const value = await readJson("valid-minimal.json");
  const collection = value.vectorCollections[0];
  collection.count = 0; collection.data.bytes = 0; collection.idMap.count = 0;
  collection.idMap.data.bytes = 0; collection.idMap.offsets.bytes = 0;
  assert.equal(validateManifest(value).vectorCollections[0].count, 0);
});
