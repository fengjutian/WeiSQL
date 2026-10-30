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
    assert.match(JSON.stringify(error.details), /safe relative resource path/);
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
  value.tables[0].files.push({ ...value.tables[0].files[0] });
  assert.throws(() => validateManifest(value), error => JSON.stringify(error.details).includes("duplicates canonical resource path"));
});

test("open loads and validates a manifest before returning a database", async () => {
  const value = await readJson("valid-minimal.json");
  const db = await open({ manifestUrl: "https://example.test/manifest.json", fetch: async () => new Response(JSON.stringify(value)) });
  assert.equal(db.manifest.format, "weisql-ai");
  await db.close();
  await db.close();
  await assert.rejects(db.sql("select 1"), { code: "DATABASE_CLOSED" });
});

test("open rejects invalid JSON", async () => {
  await assert.rejects(open({ manifestUrl: "x", fetch: async () => new Response("{") }), { code: "MANIFEST_INVALID" });
});

test("vector input validation returns stable errors before adapter lookup", async () => {
  const value = await readJson("valid-minimal.json");
  value.vectors = [{
    name: "embedding", sourceTable: "records", idColumn: "id", dimension: 2,
    elementType: "float32", metric: "cosine",
    files: [{ path: "vectors/data.f32", format: "f32-row-major", bytes: 8, sha256: "0".repeat(64) }]
  }];
  const db = await open({ manifestUrl: "x", fetch: async () => new Response(JSON.stringify(value)) });
  await assert.rejects(db.vector.search("embedding", [1, 0], { topK: 0 }), { code: "VECTOR_INVALID_VALUE" });
  await assert.rejects(db.vector.search("embedding", [1]), { code: "VECTOR_DIMENSION_MISMATCH" });
  await assert.rejects(db.vector.search("embedding", [1, Number.NaN]), { code: "VECTOR_INVALID_VALUE" });
  await assert.rejects(db.vector.search("embedding", [1, 0]), { code: "INDEX_NOT_FOUND" });
});
