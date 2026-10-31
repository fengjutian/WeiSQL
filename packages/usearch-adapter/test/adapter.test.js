import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { open, vectorDistance } from "@weisql/sdk";
import { createUSearchAdapter } from "@weisql/usearch-adapter";

const ROWS = [
  [1, 0],
  [0.9, 0.1],
  [0, 1],
];

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
  constructor(files) { this.files = files; this.closed = false; }
  async read(path) { return this.files.get(path).slice(); }
  async readRange(path, range) { return this.files.get(path).slice(range.start, range.end); }
  async stat(path) { return { size: this.files.get(path).byteLength, supportsRange: true }; }
  async close() { this.closed = true; }
}

async function fixture({ metric = "cosine" } = {}) {
  const manifest = JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
  manifest.vectorCollections[0].metric = metric;
  const idData = new TextEncoder().encode('{"row":0,"id":"doc-001"}\n{"row":1,"id":"doc-002"}\n{"row":2,"id":"doc-003"}\n');
  const reader = new MemoryReader(new Map([
    ["vectors/embeddings.f32", floats(ROWS.flat())],
    ["vectors/id-map.jsonl", idData],
    ["vectors/id-map.offsets", offsets([0, 25, 50])],
  ]));
  return { manifest, reader };
}

test("reports approximate capabilities honestly", async () => {
  const adapter = createUSearchAdapter();
  assert.equal(adapter.capabilities.engine, "usearch");
  assert.equal(adapter.capabilities.exactSearch, false);
  assert.equal(adapter.capabilities.persistedIndex, true);
  assert.deepEqual([...adapter.capabilities.metrics], ["cosine", "l2", "ip"]);
});

test("returns ranked business IDs and marks results as approximate", async () => {
  const { manifest, reader } = await fixture();
  const adapter = createUSearchAdapter();
  await adapter.open({ manifest, reader });
  const hits = await adapter.search({
    vector: manifest.vectorCollections[0],
    query: new Float32Array([1, 0]),
    topK: 3,
  });
  assert.deepEqual(hits.map(hit => hit.id), ["doc-001", "doc-002", "doc-003"]);
  assert.deepEqual(hits.map(hit => hit.row), [0, 1, 2]);
  assert.ok(Math.abs(hits[0].distance) < 1e-6);
  assert.ok(Math.abs(hits[1].distance - 0.006116) < 1e-5);
  for (const hit of hits) {
    assert.equal(hit.diagnostics.exact, false);
    assert.equal(hit.diagnostics.backend, "usearch-hnsw");
  }
  await adapter.close();
});

test("maps distance semantics for cosine, l2 and ip", async () => {
  for (const metric of ["cosine", "l2", "ip"]) {
    const { manifest, reader } = await fixture({ metric });
    const adapter = createUSearchAdapter();
    await adapter.open({ manifest, reader });
    const query = new Float32Array([1, 0]);
    const hits = await adapter.search({ vector: manifest.vectorCollections[0], query, topK: 3 });
    for (const hit of hits) {
      const expected = vectorDistance(query, Float32Array.from(ROWS[hit.row]), metric);
      assert.ok(Math.abs(hit.distance - expected) < 1e-4, `${metric} row ${hit.row}: ${hit.distance} vs ${expected}`);
    }
    await adapter.close();
  }
});

test("refuses a filtered row set instead of post-filtering", async () => {
  const { manifest, reader } = await fixture();
  const adapter = createUSearchAdapter();
  await adapter.open({ manifest, reader });
  await assert.rejects(
    adapter.search({ vector: manifest.vectorCollections[0], query: new Float32Array([1, 0]), topK: 1, allowedRows: new Set([2]) }),
    { code: "SQL_UNSUPPORTED" },
  );
  await adapter.close();
});

test("post-filter mode honours a row set and marks the result as incomplete", async () => {
  const { manifest, reader } = await fixture();
  const adapter = createUSearchAdapter({ filtering: "post-filter" });
  assert.equal(adapter.capabilities.postFiltering, true);
  assert.equal(adapter.capabilities.metadataFiltering, false);
  await adapter.open({ manifest, reader });
  const vector = manifest.vectorCollections[0];

  const hits = await adapter.search({ vector, query: new Float32Array([1, 0]), topK: 3, allowedRows: new Set([2]) });
  assert.deepEqual(hits.map(hit => hit.id), ["doc-003"]);
  assert.equal(hits[0].diagnostics.postFiltered, true);
  assert.equal(hits[0].diagnostics.filteredCandidates, 1);
  assert.ok(hits[0].diagnostics.candidatesScanned >= 1);

  // Fewer than topK is allowed: post-filtering cannot guarantee a full result.
  const short = await adapter.search({ vector, query: new Float32Array([1, 0]), topK: 2, allowedRows: new Set([2]) });
  assert.equal(short.length, 1);

  const empty = await adapter.search({ vector, query: new Float32Array([1, 0]), topK: 3, allowedRows: new Set() });
  assert.deepEqual(empty, []);

  // Unfiltered searches keep working and omit the post-filter diagnostics.
  const plain = await adapter.search({ vector, query: new Float32Array([1, 0]), topK: 1 });
  assert.equal(plain[0].diagnostics.postFiltered, undefined);
  await adapter.close();
});

test("rejects an unknown filtering mode", () => {
  assert.throws(() => createUSearchAdapter({ filtering: "smart" }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => createUSearchAdapter({ filtering: "post-filter", filterOversample: 0 }), { code: "INVALID_ARGUMENT" });
});

test("Runtime wires the ANN adapter and hides hybrid capabilities", async () => {
  const { manifest, reader } = await fixture();
  const db = await open({ manifest, resourceReader: reader, vectorAdapter: createUSearchAdapter() });
  assert.deepEqual(db.capabilities(), { sql: false, vectorExactSearch: false, vectorAnnSearch: true, hybridSearch: false, textSearch: false, fusionSearch: true, ragSearch: false, resourceRange: true });

  const hits = await db.vector.search("document_embeddings", [1, 0], { topK: 2 });
  assert.deepEqual(hits.map(hit => hit.id), ["doc-001", "doc-002"]);
  assert.equal(hits[0].diagnostics.exact, false);
  await db.close();
  assert.equal(reader.closed, true);
});

test("lifecycle: single open, idempotent close, cancelled before execution", async () => {
  const { manifest, reader } = await fixture();
  const adapter = createUSearchAdapter();
  await adapter.open({ manifest, reader });
  await assert.rejects(adapter.open({ manifest, reader }), { code: "INVALID_ARGUMENT" });

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    adapter.search({ vector: manifest.vectorCollections[0], query: new Float32Array([1, 0]), topK: 1, signal: controller.signal }),
    { code: "QUERY_CANCELLED" },
  );

  await adapter.close();
  await adapter.close();
  await assert.rejects(
    adapter.search({ vector: manifest.vectorCollections[0], query: new Float32Array([1, 0]), topK: 1 }),
    { code: "DATABASE_CLOSED" },
  );
});

test("rejects invalid construction options", () => {
  assert.throws(() => createUSearchAdapter({ connectivity: 0 }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => createUSearchAdapter({ expansionSearch: -1 }), { code: "INVALID_ARGUMENT" });
});

/** Writes a real USearch index file and returns its bytes plus the Manifest entry. */
async function persistedIndexFixture({ count = 3, connectivity = 8, expansionAdd = 32, expansionSearch = 32 } = {}) {
  const { Index } = await import("usearch");
  const { sha256Hex } = await import("@weisql/sdk");
  const index = new Index({
    metric: "cos",
    dimensions: 2,
    quantization: "f32",
    connectivity,
    expansion_add: expansionAdd,
    expansion_search: expansionSearch,
    multi: false,
  });
  index.add(new BigUint64Array([0n, 1n, 2n].slice(0, count)), new Float32Array(ROWS.slice(0, count).flat()));
  const file = path.join(await mkdtemp(path.join(tmpdir(), "weisql-usearch-test-")), "index.bin");
  index.save(file);
  const bytes = new Uint8Array(await readFile(file));
  return {
    bytes,
    descriptor: {
      engine: "usearch",
      version: "2.26.5",
      file: { path: "indexes/embeddings.usearch", bytes: bytes.byteLength, sha256: sha256Hex(bytes) },
      params: { connectivity, expansion_add: expansionAdd, expansion_search: expansionSearch },
    },
  };
}

test("loads a persisted index instead of rebuilding from vectors", async () => {
  const { bytes, descriptor } = await persistedIndexFixture();
  const { manifest } = await fixture();
  manifest.vectorCollections[0].index = descriptor;

  // Deliberately omit the vector file: a rebuild would fail, so success proves
  // the persisted index path was used.
  const reader = {
    async read(pathname) {
      if (pathname === descriptor.file.path) return bytes;
      throw new Error(`unexpected read: ${pathname}`);
    },
    async readRange(pathname, range) {
      if (pathname === "vectors/id-map.offsets" || pathname === "vectors/id-map.jsonl") {
        return new MemoryReader(new Map([
          ["vectors/id-map.jsonl", new TextEncoder().encode('{"row":0,"id":"doc-001"}\n{"row":1,"id":"doc-002"}\n{"row":2,"id":"doc-003"}\n')],
          ["vectors/id-map.offsets", offsets([0, 25, 50])],
        ])).readRange(pathname, range);
      }
      throw new Error(`unexpected range read: ${pathname}`);
    },
    async stat(pathname) { return { size: pathname === descriptor.file.path ? bytes.byteLength : 0 }; },
    async close() {},
  };

  const adapter = createUSearchAdapter();
  await adapter.open({ manifest, reader });
  const hits = await adapter.search({ vector: manifest.vectorCollections[0], query: new Float32Array([1, 0]), topK: 3 });
  assert.deepEqual(hits.map(hit => hit.id), ["doc-001", "doc-002", "doc-003"]);
  assert.equal(hits[0].diagnostics.exact, false);
  await adapter.close();
});

test("rejects an index built by a different engine or for a different count", async () => {
  const { bytes, descriptor } = await persistedIndexFixture();

  const wrongEngine = await fixture();
  wrongEngine.manifest.vectorCollections[0].index = { ...descriptor, engine: "faiss" };
  const engineReader = { async read() { return bytes; }, async readRange() { throw new Error("no"); }, async stat() { return { size: bytes.byteLength }; }, async close() {} };
  const engineAdapter = createUSearchAdapter();
  await engineAdapter.open({ manifest: wrongEngine.manifest, reader: engineReader });
  await assert.rejects(
    engineAdapter.search({ vector: wrongEngine.manifest.vectorCollections[0], query: new Float32Array([1, 0]), topK: 1 }),
    { code: "INDEX_NOT_FOUND" },
  );

  const wrongCount = await fixture();
  wrongCount.manifest.vectorCollections[0].count = 2;
  wrongCount.manifest.vectorCollections[0].idMap.count = 2;
  wrongCount.manifest.vectorCollections[0].index = descriptor;
  const countAdapter = createUSearchAdapter();
  await countAdapter.open({ manifest: wrongCount.manifest, reader: engineReader });
  await assert.rejects(
    countAdapter.search({ vector: wrongCount.manifest.vectorCollections[0], query: new Float32Array([1, 0]), topK: 1 }),
    { code: "RESOURCE_INTEGRITY_FAILED" },
  );
});

test("rejects a persisted index built with an incompatible USearch major version", async () => {
  const { bytes, descriptor } = await persistedIndexFixture();
  const base = await fixture();
  const reader = {
    async read(pathname) { return pathname === descriptor.file.path ? bytes : base.reader.read(pathname); },
    async readRange(pathname, range) { return pathname === descriptor.file.path ? bytes.slice(range.start, range.end) : base.reader.readRange(pathname, range); },
    async stat(pathname) { return pathname === descriptor.file.path ? { size: bytes.byteLength } : base.reader.stat(pathname); },
    async close() {},
  };

  const incompatible = await fixture();
  incompatible.manifest.vectorCollections[0].index = { ...descriptor, version: "1.9.0" };
  const wrongMajor = createUSearchAdapter();
  await wrongMajor.open({ manifest: incompatible.manifest, reader });
  await assert.rejects(
    wrongMajor.search({ vector: incompatible.manifest.vectorCollections[0], query: new Float32Array([1, 0]), topK: 1 }),
    { code: "RESOURCE_INTEGRITY_FAILED" },
  );

  // A different minor/patch within the same major is accepted: the Manifest records
  // the exact build version, but only the major is a compatibility boundary.
  const sameMajor = await fixture();
  sameMajor.manifest.vectorCollections[0].index = { ...descriptor, version: "2.99.0" };
  const adapter = createUSearchAdapter();
  await adapter.open({ manifest: sameMajor.manifest, reader });
  const hits = await adapter.search({ vector: sameMajor.manifest.vectorCollections[0], query: new Float32Array([1, 0]), topK: 1 });
  assert.equal(hits[0].id, "doc-001");
  await adapter.close();
});

test("rejects a persisted index whose bytes do not match the Manifest", async () => {
  const { descriptor } = await persistedIndexFixture();
  const { manifest } = await fixture();
  manifest.vectorCollections[0].index = { ...descriptor, file: { ...descriptor.file, bytes: descriptor.file.bytes + 8 } };
  const reader = { async read() { return new Uint8Array(4); }, async readRange() { throw new Error("no"); }, async stat() { return { size: 4 }; }, async close() {} };
  const adapter = createUSearchAdapter();
  await adapter.open({ manifest, reader });
  await assert.rejects(
    adapter.search({ vector: manifest.vectorCollections[0], query: new Float32Array([1, 0]), topK: 1 }),
    { code: "RESOURCE_INTEGRITY_FAILED" },
  );
});

test("rejects a persisted index without its build parameters", async () => {
  const { descriptor } = await persistedIndexFixture();
  const reader = {
    async read() { throw new Error("must not read an index without build parameters"); },
    async readRange() { throw new Error("must not read an index without build parameters"); },
    async stat() { return { size: descriptor.file.bytes }; },
    async close() {},
  };

  // ADR-029: no fallback to adapter defaults, because that silently changes recall.
  const { params: _omitted, ...withoutParams } = descriptor;
  const missing = await fixture();
  missing.manifest.vectorCollections[0].index = withoutParams;
  const missingAdapter = createUSearchAdapter();
  await missingAdapter.open({ manifest: missing.manifest, reader });
  await assert.rejects(
    missingAdapter.search({ vector: missing.manifest.vectorCollections[0], query: new Float32Array([1, 0]), topK: 1 }),
    error => error.code === "RESOURCE_INTEGRITY_FAILED"
      && Array.isArray(error.details?.required)
      && error.details.required.includes("connectivity"),
  );

  const partial = await fixture();
  partial.manifest.vectorCollections[0].index = { ...descriptor, params: { connectivity: 8 } };
  const partialAdapter = createUSearchAdapter();
  await partialAdapter.open({ manifest: partial.manifest, reader });
  await assert.rejects(
    partialAdapter.search({ vector: partial.manifest.vectorCollections[0], query: new Float32Array([1, 0]), topK: 1 }),
    error => error.code === "RESOURCE_INTEGRITY_FAILED" && error.details?.parameter === "expansion_add",
  );
});
