import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { createExactVectorAdapter, open } from "../dist/index.js";

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

async function fixturePackage() {
  const manifest = JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
  const idData = new TextEncoder().encode('{"row":0,"id":"doc-001"}\n{"row":1,"id":"doc-002"}\n{"row":2,"id":"doc-003"}\n');
  const reader = new MemoryReader(new Map([
    ["vectors/embeddings.f32", floats([1, 0, 0.9, 0.1, 0, 1])],
    ["vectors/id-map.jsonl", idData],
    ["vectors/id-map.offsets", offsets([0, 25, 50])],
  ]));
  return { manifest, reader };
}

function fakeSqlAdapter(rows) {
  return {
    capabilities: { engine: "fake-sql", parameterBinding: true, parquet: false, supportedFeatures: [], cancellation: "unsupported" },
    async open() {},
    async query() { return rows; },
    async close() {},
  };
}

/** Exact adapter that records what the Runtime asked for. */
function recordingExactAdapter(requests) {
  const inner = createExactVectorAdapter();
  return {
    capabilities: inner.capabilities,
    open: context => inner.open(context),
    close: () => inner.close(),
    async search(request) {
      requests.push({ topK: request.topK, allowedRows: request.allowedRows === undefined ? undefined : [...request.allowedRows] });
      return inner.search(request);
    },
  };
}

test("injected exact adapter produces the same results as the built-in pipeline", async () => {
  const builtin = await fixturePackage();
  const defaultDb = await open({ manifest: builtin.manifest, resourceReader: builtin.reader });
  const defaultHits = await defaultDb.vector.search("document_embeddings", [1, 0], { topK: 2 });
  await defaultDb.close();

  const injected = await fixturePackage();
  const adapter = createExactVectorAdapter();
  const db = await open({ manifest: injected.manifest, resourceReader: injected.reader, vectorAdapter: adapter });
  assert.deepEqual(db.capabilities(), { sql: false, vectorExactSearch: true, vectorAnnSearch: false, hybridSearch: false, textSearch: false, fusionSearch: true, ragSearch: false, resourceRange: true });
  const hits = await db.vector.search("document_embeddings", [1, 0], { topK: 2 });
  await db.close();

  assert.deepEqual(hits.map(hit => hit.id), defaultHits.map(hit => hit.id));
  assert.deepEqual(hits.map(hit => hit.row), defaultHits.map(hit => hit.row));
  assert.deepEqual(hits.map(hit => hit.distance), defaultHits.map(hit => hit.distance));
  assert.equal(hits[0].diagnostics.exact, true);
  assert.equal(hits[0].diagnostics.backend, defaultHits[0].diagnostics.backend);
});

test("Runtime resolves the filter into a row set before calling the adapter", async () => {
  const { manifest, reader } = await fixturePackage();
  const requests = [];
  const db = await open({
    manifest,
    resourceReader: reader,
    sqlAdapter: fakeSqlAdapter([{ id: "doc-003" }]),
    vectorAdapter: recordingExactAdapter(requests),
  });
  assert.equal(db.capabilities().hybridSearch, true);

  const hits = await db.vector.search("document_embeddings", [1, 0], { topK: 1, filter: { content: "x" } });
  assert.deepEqual(hits.map(hit => hit.id), ["doc-003"]);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].allowedRows, [2], "the adapter must receive the resolved row, not the SQL filter");
  await db.close();
});

test("an approximate adapter is reported honestly and cannot pretend to filter", async () => {
  const { manifest, reader } = await fixturePackage();
  const ann = {
    capabilities: Object.freeze({
      engine: "fake-ann",
      metrics: ["cosine"],
      persistedIndex: true,
      metadataFiltering: false,
      exactSearch: false,
      cancellation: "unsupported",
    }),
    opened: false,
    closed: false,
    async open() { this.opened = true; },
    async close() { this.closed = true; },
    async search({ topK }) {
      return Array.from({ length: topK }, (_, index) => ({
        row: index,
        id: `approx-${index}`,
        distance: index / 10,
        diagnostics: { backend: "fake-ann", exact: false },
      }));
    },
  };

  const db = await open({ manifest, resourceReader: reader, sqlAdapter: fakeSqlAdapter([{ id: "doc-003" }]), vectorAdapter: ann });
  assert.equal(ann.opened, true);
  assert.deepEqual(db.capabilities(), { sql: true, vectorExactSearch: false, vectorAnnSearch: true, hybridSearch: false, textSearch: false, fusionSearch: true, ragSearch: false, resourceRange: true });

  const hits = await db.vector.search("document_embeddings", [1, 0], { topK: 2 });
  assert.deepEqual(hits.map(hit => hit.id), ["approx-0", "approx-1"]);
  assert.equal(hits[0].diagnostics.exact, false);

  await assert.rejects(db.vector.search("document_embeddings", [1, 0], { filter: { content: "x" } }), { code: "SQL_UNSUPPORTED" });
  await db.close();
  assert.equal(ann.closed, true);
});

test("a post-filtering adapter may accept filters and the Runtime keeps it inside the row set", async () => {
  const { manifest, reader } = await fixturePackage();
  const searchRequests = [];
  const post = {
    capabilities: {
      engine: "fake-post",
      metrics: ["cosine"],
      persistedIndex: false,
      metadataFiltering: false,
      postFiltering: true,
      exactSearch: false,
      cancellation: "unsupported",
    },
    async open() {},
    async close() {},
    async search({ topK, allowedRows }) {
      searchRequests.push(allowedRows === undefined ? undefined : [...allowedRows]);
      const rows = [...(allowedRows ?? [0, 1, 2])].slice(0, topK);
      return rows.map(row => ({
        row,
        id: `row-${row}`,
        distance: row / 10,
        diagnostics: { backend: "fake-post", exact: false, postFiltered: allowedRows !== undefined },
      }));
    },
  };

  const db = await open({ manifest, resourceReader: reader, sqlAdapter: fakeSqlAdapter([{ id: "doc-003" }]), vectorAdapter: post });
  // Post-filtering never makes hybrid (exact) semantics available.
  assert.equal(db.capabilities().hybridSearch, false);

  const hits = await db.vector.search("document_embeddings", [1, 0], { topK: 3, filter: { content: "x" } });
  assert.deepEqual(hits.map(hit => hit.row), [2]);
  assert.deepEqual(searchRequests, [[2]]);
  await db.close();
});

test("the Runtime rejects adapter hits outside the requested filter", async () => {
  const { manifest, reader } = await fixturePackage();
  const leaky = {
    capabilities: { engine: "fake-leaky", metrics: ["cosine"], persistedIndex: false, metadataFiltering: false, postFiltering: true, exactSearch: false, cancellation: "unsupported" },
    async open() {},
    async close() {},
    async search() {
      return [{ row: 0, id: "doc-001", distance: 0, diagnostics: { backend: "fake-leaky", exact: false } }];
    },
  };
  const db = await open({ manifest, resourceReader: reader, sqlAdapter: fakeSqlAdapter([{ id: "doc-003" }]), vectorAdapter: leaky });
  await assert.rejects(db.vector.search("document_embeddings", [1, 0], { filter: { content: "x" } }), { code: "INTERNAL_ERROR" });
  await db.close();
});

test("adapter lifecycle failures release every resource", async () => {
  const { manifest, reader } = await fixturePackage();
  const ann = {
    capabilities: { engine: "broken", metrics: ["cosine"], persistedIndex: false, metadataFiltering: false, exactSearch: false, cancellation: "unsupported" },
    closed: false,
    async open() { throw new Error("index load failed"); },
    async close() { this.closed = true; },
    async search() { return []; },
  };
  await assert.rejects(open({ manifest, resourceReader: reader, vectorAdapter: ann }), /index load failed/);
  assert.equal(ann.closed, true);
  assert.equal(reader.closed, true);
});

test("a vector adapter without a reader is rejected", async () => {
  const { manifest } = await fixturePackage();
  await assert.rejects(open({ manifest, vectorAdapter: createExactVectorAdapter() }), { code: "INVALID_ARGUMENT" });
});

test("closing the Runtime closes the adapter and later searches fail", async () => {
  const { manifest, reader } = await fixturePackage();
  const adapter = createExactVectorAdapter();
  const db = await open({ manifest, resourceReader: reader, vectorAdapter: adapter });
  await db.close();
  assert.equal(db.state, "CLOSED");
  await assert.rejects(db.vector.search("document_embeddings", [1, 0]), { code: "DATABASE_CLOSED" });
});
