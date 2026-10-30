import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
  assert.equal(adapter.capabilities.persistedIndex, false);
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

test("Runtime wires the ANN adapter and hides hybrid capabilities", async () => {
  const { manifest, reader } = await fixture();
  const db = await open({ manifest, resourceReader: reader, vectorAdapter: createUSearchAdapter() });
  assert.deepEqual(db.capabilities(), { sql: false, vectorExactSearch: false, vectorAnnSearch: true, hybridSearch: false, resourceRange: true });

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
