import assert from "node:assert/strict";
import test from "node:test";
import { compareCandidate, decodeUint64LE, exactVectorSearch, IndexedIdMapReader, parseIdMapLine, TopKMaxHeap, VectorBlockReader } from "../dist/index.js";

class MultiResourceReader {
  calls = [];
  constructor(resources) { this.resources = resources; }
  async read(path) { return this.resources[path].slice(); }
  async readRange(path, range) {
    this.calls.push({ path, range });
    const bytes = this.resources[path];
    if (!bytes) throw new Error(`missing ${path}`);
    return bytes.slice(range.start, range.end);
  }
  async stat(path) { return { size: this.resources[path]?.byteLength }; }
  async close() {}
}

function idMapFixture(records) {
  const encoder = new TextEncoder();
  const lines = records.map(record => encoder.encode(`${JSON.stringify(record)}\n`));
  const offsets = new Uint8Array(records.length * 8);
  const view = new DataView(offsets.buffer);
  let position = 0;
  lines.forEach((line, index) => { view.setBigUint64(index * 8, BigInt(position), true); position += line.byteLength; });
  const data = new Uint8Array(position);
  position = 0;
  for (const line of lines) { data.set(line, position); position += line.byteLength; }
  return { data, offsets };
}

function floatBytes(values) {
  const bytes = new Uint8Array(values.length * 4); const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true)); return bytes;
}

test("TopKMaxHeap retains the nearest candidates in stable order", () => {
  const heap = new TopKMaxHeap(3);
  for (const [row, distance] of [[0, 0.9], [1, 0.2], [2, 0.5], [3, 0.1], [4, 0.8]]) heap.offer({ row, id: `doc-${row}`, distance });
  assert.deepEqual(heap.toSortedArray().map(item => item.row), [3, 1, 2]);
  assert.equal(heap.size, 3);

  const ties = new TopKMaxHeap(2);
  for (const row of [8, 3, 5]) ties.offer({ row, id: row, distance: 0.2 });
  assert.deepEqual(ties.toSortedArray().map(item => item.row), [3, 5]);
});

test("TopKMaxHeap matches a full deterministic sort", () => {
  const candidates = Array.from({ length: 257 }, (_, row) => ({ row, id: row, distance: ((row * 73) % 101) / 10 }));
  const heap = new TopKMaxHeap(17);
  for (const candidate of candidates) heap.offer(candidate);
  assert.deepEqual(heap.toSortedArray(), [...candidates].sort(compareCandidate).slice(0, 17));
});

test("TopKMaxHeap rejects invalid capacity and candidates", () => {
  assert.throws(() => new TopKMaxHeap(0), { code: "INVALID_ARGUMENT" });
  const heap = new TopKMaxHeap(2);
  assert.throws(() => heap.offer({ row: 0, id: "a", distance: Number.NaN }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => heap.offer({ row: -1, id: "a", distance: 0 }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => heap.offer({ row: 1, id: "", distance: 0 }), { code: "INVALID_ARGUMENT" });
});

test("decodes UInt64 offsets and JSONL ID records", () => {
  const bytes = new Uint8Array(9); new DataView(bytes.buffer, 1, 8).setBigUint64(0, 1234n, true);
  assert.equal(decodeUint64LE(bytes.subarray(1), 0), 1234n);
  assert.deepEqual(parseIdMapLine(new TextEncoder().encode('{"row":2,"id":"doc-2"}')), { row: 2, id: "doc-2" });
  assert.throws(() => decodeUint64LE(new Uint8Array(7), 0), { code: "RESOURCE_INTEGRITY_FAILED" });
  assert.throws(() => parseIdMapLine(new TextEncoder().encode('{"row":0,"id":""}')), { code: "RESOURCE_INTEGRITY_FAILED" });
});

test("IndexedIdMapReader batch-reads middle and final records", async () => {
  const fixture = idMapFixture([{ row: 0, id: "doc-0" }, { row: 1, id: 42 }, { row: 2, id: "doc-2" }, { row: 3, id: "doc-3" }]);
  const resources = { "ids.jsonl": fixture.data, "ids.offsets": fixture.offsets };
  const resource = new MultiResourceReader(resources);
  const reader = new IndexedIdMapReader(resource, { dataPath: "ids.jsonl", offsetsPath: "ids.offsets", count: 4, dataBytes: fixture.data.byteLength, offsetsBytes: fixture.offsets.byteLength });
  assert.deepEqual(await reader.getIds(1, 2), [42, "doc-2"]);
  assert.deepEqual(await reader.getIds(3, 10), ["doc-3"]);
  assert.equal(resource.calls.length, 4); // one offsets + one JSONL range per request
  assert.deepEqual(resource.calls[0], { path: "ids.offsets", range: { start: 8, end: 32 } });
  await reader.close(); await reader.close();
  await assert.rejects(reader.getIds(0, 1), { code: "DATABASE_CLOSED" });
});

test("exact search integrates vector ranges, indexed IDs and heap Top-K", async () => {
  const fixture = idMapFixture([{ row: 0, id: "doc-001" }, { row: 1, id: "doc-002" }, { row: 2, id: "doc-003" }]);
  const vectors = floatBytes([1, 0, 0.9, 0.1, 0, 1]);
  const resource = new MultiResourceReader({ vectors, ids: fixture.data, offsets: fixture.offsets });
  const vectorReader = new VectorBlockReader(resource, { path: "vectors", count: 3, dimension: 2, bytes: vectors.byteLength });
  const idMap = new IndexedIdMapReader(resource, { dataPath: "ids", offsetsPath: "offsets", count: 3, dataBytes: fixture.data.byteLength, offsetsBytes: fixture.offsets.byteLength });
  const hits = await exactVectorSearch({ reader: vectorReader, idMap, query: new Float32Array([1, 0]), collectionCount: 3, dimension: 2, search: { topK: 2, metric: "cosine", blockSize: 2 } });
  assert.deepEqual(hits.map(hit => hit.id), ["doc-001", "doc-002"]);
  assert.deepEqual(hits.map(hit => hit.row), [0, 1]);
});

test("IndexedIdMapReader rejects corrupt indexes and records", async t => {
  await t.test("truncated index", async () => {
    const fixture = idMapFixture([{ row: 0, id: "a" }, { row: 1, id: "b" }]);
    const reader = new IndexedIdMapReader(new MultiResourceReader({ data: fixture.data, offsets: fixture.offsets.slice(0, 8) }), { dataPath: "data", offsetsPath: "offsets", count: 2, dataBytes: fixture.data.byteLength, offsetsBytes: fixture.offsets.byteLength });
    await assert.rejects(reader.getIds(0, 1), { code: "RESOURCE_INTEGRITY_FAILED" });
  });
  await t.test("non-monotonic offsets", async () => {
    const fixture = idMapFixture([{ row: 0, id: "a" }, { row: 1, id: "b" }]);
    new DataView(fixture.offsets.buffer).setBigUint64(8, 0n, true);
    const reader = new IndexedIdMapReader(new MultiResourceReader({ data: fixture.data, offsets: fixture.offsets }), { dataPath: "data", offsetsPath: "offsets", count: 2, dataBytes: fixture.data.byteLength, offsetsBytes: fixture.offsets.byteLength });
    await assert.rejects(reader.getIds(0, 1), { code: "RESOURCE_INTEGRITY_FAILED" });
  });
  await t.test("wrong row", async () => {
    const fixture = idMapFixture([{ row: 9, id: "a" }]);
    const reader = new IndexedIdMapReader(new MultiResourceReader({ data: fixture.data, offsets: fixture.offsets }), { dataPath: "data", offsetsPath: "offsets", count: 1, dataBytes: fixture.data.byteLength, offsetsBytes: fixture.offsets.byteLength });
    await assert.rejects(reader.getIds(0, 1), { code: "RESOURCE_INTEGRITY_FAILED" });
  });
});
