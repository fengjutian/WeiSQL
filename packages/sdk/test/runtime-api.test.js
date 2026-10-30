import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { open } from "../dist/index.js";

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
  closed = false;
  constructor(files) { this.files = files; }
  async read(path) { return this.files.get(path).slice(); }
  async readRange(path, range) { return this.files.get(path).slice(range.start, range.end); }
  async stat(path) { return { size: this.files.get(path).byteLength, supportsRange: true }; }
  async close() { this.closed = true; }
}

test("public Runtime opens an injected package and executes exact vector search", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
  const idData = new TextEncoder().encode('{"row":0,"id":"doc-001"}\n{"row":1,"id":"doc-002"}\n{"row":2,"id":"doc-003"}\n');
  assert.equal(idData.byteLength, 75);
  const reader = new MemoryReader(new Map([
    ["vectors/embeddings.f32", floats([1, 0, 0.9, 0.1, 0, 1])],
    ["vectors/id-map.jsonl", idData],
    ["vectors/id-map.offsets", offsets([0, 25, 50])],
  ]));
  const db = await open({ manifest, resourceReader: reader, mode: "readonly" });
  assert.deepEqual(db.capabilities(), { sql: false, vectorExactSearch: true, vectorAnnSearch: false, hybridSearch: false, resourceRange: true });
  const hits = await db.vector.search("document_embeddings", new Float32Array([1, 0]), { topK: 2 });
  assert.deepEqual(hits.map(hit => hit.id), ["doc-001", "doc-002"]);
  assert.deepEqual(hits.map(hit => hit.row), [0, 1]);
  assert.equal(hits[0].diagnostics.exact, true);
  await assert.rejects(db.sql("select 1"), { code: "SQL_UNSUPPORTED" });
  await assert.rejects(db.vector.search("document_embeddings", [1, 0], { filter: { category: "x" } }), { code: "SQL_UNSUPPORTED" });
  await db.close();
  assert.equal(reader.closed, true);
});

test("Runtime requires exactly one Manifest source", async () => {
  await assert.rejects(open({}), { code: "INVALID_ARGUMENT" });
  await assert.rejects(open({ manifest: {}, manifestUrl: "x" }), { code: "INVALID_ARGUMENT" });
});

test("Runtime initializes, delegates to and closes a SQL adapter", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
  const reader = new MemoryReader(new Map());
  const calls = [];
  const adapter = {
    capabilities: { engine: "test-sql", parameterBinding: true, parquet: true, supportedFeatures: ["select"], cancellation: "native" },
    async open(context) { calls.push(["open", context.manifest.datasetId]); },
    async query(statement, parameters) { calls.push(["query", statement, parameters]); return [{ id: parameters[0] }]; },
    async close() { calls.push(["close"]); },
  };
  const db = await open({ manifest, resourceReader: reader, sqlAdapter: adapter });
  assert.equal(db.state, "READY");
  assert.equal(db.capabilities().sql, true);
  assert.deepEqual(await db.sql("select id from documents where id = ?", ["doc-001"]), [{ id: "doc-001" }]);
  await db.close();
  assert.equal(db.state, "CLOSED");
  assert.equal(reader.closed, true);
  assert.deepEqual(calls, [
    ["open", "demo-docs"],
    ["query", "select id from documents where id = ?", ["doc-001"]],
    ["close"],
  ]);
});

test("Runtime releases initialized resources when SQL adapter open fails", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
  const reader = new MemoryReader(new Map());
  let adapterClosed = false;
  const adapter = {
    capabilities: { engine: "broken", parameterBinding: true, parquet: true, supportedFeatures: [], cancellation: "unsupported" },
    async open() { throw new Error("initialization failed"); },
    async query() { return []; },
    async close() { adapterClosed = true; },
  };
  await assert.rejects(open({ manifest, resourceReader: reader, sqlAdapter: adapter }), /initialization failed/);
  assert.equal(adapterClosed, true);
  assert.equal(reader.closed, true);
});

test("concurrent close calls share cleanup completion", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
  let release;
  const reader = new MemoryReader(new Map());
  reader.close = () => new Promise(resolve => { release = () => { reader.closed = true; resolve(); }; });
  const db = await open({ manifest, resourceReader: reader });
  const first = db.close();
  const second = db.close();
  assert.equal(db.state, "CLOSING");
  let secondFinished = false;
  second.then(() => { secondFinished = true; });
  await Promise.resolve();
  assert.equal(secondFinished, false);
  release();
  await Promise.all([first, second]);
  assert.equal(db.state, "CLOSED");
});
