import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { NodeFileResourceReader, SortedIdIndexReader, buildPackage, declaredResources, open, validateIdIndexContent, validateManifest, verifyManifestResources } from "../dist/index.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCE_PARQUET = path.join(REPO_ROOT, "examples", "source", "documents.parquet");
const IDS = ["doc-001", "doc-002", "doc-003"];

class CountingReader {
  constructor(inner) { this.inner = inner; this.bytesByPath = new Map(); this.readsByPath = new Map(); }
  async read(pathname, options) { return this.#count(pathname, await this.inner.read(pathname, options)); }
  async readRange(pathname, range, options) { return this.#count(pathname, await this.inner.readRange(pathname, range, options)); }
  async stat(pathname, options) { return this.inner.stat(pathname, options); }
  async close() { await this.inner.close(); }
  #count(pathname, bytes) {
    this.bytesByPath.set(pathname, (this.bytesByPath.get(pathname) ?? 0) + bytes.byteLength);
    this.readsByPath.set(pathname, (this.readsByPath.get(pathname) ?? 0) + 1);
    return bytes;
  }
}

async function build(temp, overrides = {}) {
  return buildPackage({
    outputDirectory: path.join(temp, "package"),
    datasetId: "demo-documents",
    tables: [{
      name: "documents",
      parquetPath: SOURCE_PARQUET,
      columns: [
        { name: "id", type: "string", nullable: false },
        { name: "title", type: "string", nullable: false },
        { name: "category", type: "string", nullable: false },
      ],
      primaryKey: ["id"],
      rowIds: IDS,
    }],
    vectorCollections: [{
      name: "document_embeddings",
      tableName: "documents",
      idColumn: "id",
      metric: "cosine",
      vectors: [[1, 0], [0.9, 0.1], [0, 1]],
      ids: IDS,
    }],
    ...overrides,
  });
}

function fakeSqlAdapter(ids) {
  return {
    capabilities: { engine: "fake", parameterBinding: true, parquet: true, supportedFeatures: [], cancellation: "native" },
    async open() {},
    async query() { return ids.map(id => ({ id })); },
    async close() {},
  };
}

test("Builder writes a sorted id index and the runtime uses it", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "weisql-idindex-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const report = await build(temp);
  const collection = report.manifest.vectorCollections[0];
  assert.ok(collection.idIndex, "Builder must add an idIndex for unique IDs");
  assert.equal(collection.idIndex.count, 3);
  assert.equal(collection.idIndex.idType, "string");
  assert.equal(validateManifest(report.manifest).vectorCollections[0].idIndex?.uniqueIds, true);

  const invalid = structuredClone(report.manifest);
  invalid.vectorCollections[0].idIndex.count = 4;
  assert.throws(() => validateManifest(invalid), { code: "MANIFEST_INVALID" });

  const counting = new CountingReader(new NodeFileResourceReader({ rootDirectory: path.join(temp, "package") }));
  const db = await open({ manifest: report.manifest, resourceReader: counting, sqlAdapter: fakeSqlAdapter(["doc-003"]) });
  try {
    const hits = await db.vector.search(collection.name, [1, 0], { topK: 1, filter: { category: "x" } });
    assert.deepEqual(hits.map(hit => hit.id), ["doc-003"]);
  } finally {
    await db.close();
  }

  // The id index is consulted (its records are read), not rebuilt from the ID Map.
  assert.ok((counting.bytesByPath.get(collection.idIndex.data.path) ?? 0) > 0);
});

test("without an id index the filter falls back to the full ID Map scan", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "weisql-idindex-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const report = await build(temp);
  const manifest = structuredClone(report.manifest);
  const collection = manifest.vectorCollections[0];
  delete collection.idIndex;

  const counting = new CountingReader(new NodeFileResourceReader({ rootDirectory: path.join(temp, "package") }));
  const db = await open({ manifest, resourceReader: counting, sqlAdapter: fakeSqlAdapter(["doc-001"]) });
  try {
    const hits = await db.vector.search(collection.name, [1, 0], { topK: 1, filter: { category: "x" } });
    assert.deepEqual(hits.map(hit => hit.id), ["doc-001"]);
  } finally {
    await db.close();
  }
  assert.ok(counting.bytesByPath.get(collection.idMap.data.path) > 0);
});

test("the id index loads once and rejects malformed data", async () => {
  const count = 512;
  const lines = [];
  for (let index = 0; index < count; index++) {
    lines.push(Buffer.from(`{"id":"id-${String(index).padStart(3, "0")}","row":${index}}\n`));
  }
  const data = Buffer.concat(lines);
  const files = new Map([
    ["ids.jsonl", data],
    ["ids.offsets", Buffer.alloc(count * 8)],
  ]);
  const memoryReader = source => ({
    async read(pathname) { return new Uint8Array(source.get(pathname)); },
    async readRange(pathname, range) { return new Uint8Array(source.get(pathname).subarray(range.start, range.end)); },
    async stat(pathname) { return { size: source.get(pathname).byteLength, supportsRange: true }; },
    async close() {},
  });
  const descriptor = {
    data: { path: "ids.jsonl", bytes: data.byteLength, sha256: "0".repeat(64), format: "jsonl" },
    offsets: { path: "ids.offsets", bytes: count * 8, sha256: "0".repeat(64), format: "uint64-le" },
    count,
    idType: "string",
    uniqueIds: true,
  };

  const counting = new CountingReader(memoryReader(files));
  const index = new SortedIdIndexReader(counting, descriptor);
  assert.deepEqual(await index.rowsOf(["id-000", "id-256", "id-511", "missing"]), [0, 256, 511]);
  // One read for the whole file, not one per lookup.
  assert.equal(counting.readsByPath.get("ids.jsonl"), 1);
  assert.equal(counting.readsByPath.get("ids.offsets"), undefined);
  // A second query reuses the loaded index.
  assert.deepEqual(await index.rowsOf(["id-001"]), [1]);
  assert.equal(counting.readsByPath.get("ids.jsonl"), 1);
  await index.close();

  const wrongLength = new SortedIdIndexReader(counting, { ...descriptor, data: { ...descriptor.data, bytes: data.byteLength + 1 } });
  await assert.rejects(wrongLength.rowsOf(["id-000"]), { code: "RESOURCE_INTEGRITY_FAILED" });

  const malformed = Buffer.from('{"id":"a","row":0}\nnot-json\n');
  const broken = new SortedIdIndexReader(memoryReader(new Map([["ids.jsonl", malformed], ["ids.offsets", Buffer.alloc(16)]])), {
    ...descriptor,
    data: { ...descriptor.data, bytes: malformed.byteLength },
  });
  await assert.rejects(broken.rowsOf(["a"]), { code: "RESOURCE_INTEGRITY_FAILED" });
});

test("L3 verifies the id index and rejects a corrupt one", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "weisql-idindex-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const report = await build(temp);
  const collection = report.manifest.vectorCollections[0];

  const kinds = declaredResources(report.manifest).map(resource => resource.kind);
  assert.ok(kinds.includes("id-index-data"));
  assert.ok(kinds.includes("id-index-offsets"));

  const reader = new NodeFileResourceReader({ rootDirectory: path.join(temp, "package") });
  try {
    const integrity = await verifyManifestResources({ manifest: report.manifest, reader, options: { mode: "all" } });
    assert.equal(integrity.checkedResources, 6);
    assert.equal(integrity.hashesVerified, 6);
  } finally {
    await reader.close();
  }

  const unsorted = new TextEncoder().encode('{"id":"doc-002","row":1}\n{"id":"doc-001","row":0}\n{"id":"doc-003","row":2}\n');
  assert.throws(() => validateIdIndexContent(collection, unsorted), /strictly sorted/);

  const duplicate = new TextEncoder().encode('{"id":"doc-001","row":0}\n{"id":"doc-002","row":0}\n{"id":"doc-003","row":2}\n');
  assert.throws(() => validateIdIndexContent(collection, duplicate), /repeats a row/);
});
