import assert from "node:assert/strict";
import test from "node:test";
import { exactVectorSearch, vectorDistance, VectorBlockReader } from "../dist/index.js";

function encodeFloat32(values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

class MemoryResourceReader {
  calls = [];
  closed = false;
  constructor(bytes, truncate = 0) { this.bytes = bytes; this.truncate = truncate; }
  async read() { return this.bytes.slice(); }
  async readRange(path, range, options) {
    if (options?.signal?.aborted) throw Object.assign(new Error("cancelled"), { code: "QUERY_CANCELLED" });
    this.calls.push({ path, range });
    return this.bytes.slice(range.start, Math.max(range.start, range.end - this.truncate));
  }
  async stat() { return { size: this.bytes.byteLength, supportsRange: true }; }
  async close() { this.closed = true; }
}

class MemoryIdMap {
  constructor(ids, onRead) { this.ids = ids; this.onRead = onRead; }
  async getIds(startRow, count) { this.onRead?.(startRow, count); return this.ids.slice(startRow, startRow + count); }
  async getIdsByRows(rows) { this.onRead?.(rows[0], rows.length); return rows.map(row => this.ids[row]); }
  async close() {}
}

test("VectorBlockReader decodes little-endian Float32 blocks and a short final block", async () => {
  const resource = new MemoryResourceReader(encodeFloat32([1, 2, 3, 4, 5, 6]));
  const reader = new VectorBlockReader(resource, { path: "vectors/data.f32", count: 3, dimension: 2, bytes: 24 });
  const first = await reader.readBlock(0, 2);
  assert.equal(first.startRow, 0); assert.equal(first.count, 2);
  assert.deepEqual([...first.values], [1, 2, 3, 4]);
  const last = await reader.readBlock(2, 10);
  assert.equal(last.count, 1); assert.deepEqual([...last.values], [5, 6]);
  assert.deepEqual(resource.calls.map(call => call.range), [{ start: 0, end: 16 }, { start: 16, end: 24 }]);
});

test("VectorBlockReader rejects descriptor, byte length and non-finite data errors", async () => {
  const bytes = encodeFloat32([1, 2]);
  assert.throws(() => new VectorBlockReader(new MemoryResourceReader(bytes), { path: "v", count: 1, dimension: 2, bytes: 7 }), { code: "INVALID_ARGUMENT" });
  const short = new VectorBlockReader(new MemoryResourceReader(bytes, 1), { path: "v", count: 1, dimension: 2, bytes: 8 });
  await assert.rejects(short.readBlock(0, 1), { code: "RESOURCE_INTEGRITY_FAILED" });
  const nonFiniteBytes = encodeFloat32([1, Number.NaN]);
  const nonFinite = new VectorBlockReader(new MemoryResourceReader(nonFiniteBytes), { path: "v", count: 1, dimension: 2, bytes: 8 });
  await assert.rejects(nonFinite.readBlock(0, 1), { code: "RESOURCE_INTEGRITY_FAILED" });
});

test("distance functions share smaller-is-better semantics", () => {
  assert.ok(Math.abs(vectorDistance(new Float32Array([1, 0]), new Float32Array([1, 0]), "cosine")) < 1e-12);
  assert.equal(vectorDistance(new Float32Array([0, 0]), new Float32Array([3, 4]), "l2"), 5);
  assert.equal(vectorDistance(new Float32Array([1, 2]), new Float32Array([3, 4]), "ip"), -11);
  assert.throws(() => vectorDistance(new Float32Array([1]), new Float32Array([1, 2]), "l2"), { code: "VECTOR_DIMENSION_MISMATCH" });
  assert.throws(() => vectorDistance(new Float32Array([0, 0]), new Float32Array([1, 0]), "cosine"), { code: "VECTOR_INVALID_VALUE" });
  assert.throws(() => vectorDistance(new Float32Array([Number.NaN]), new Float32Array([1]), "ip"), { code: "VECTOR_INVALID_VALUE" });
});

test("exact search streams blocks, maps IDs and returns stable Top-K", async () => {
  const resource = new MemoryResourceReader(encodeFloat32([1, 0, 0.9, 0.1, 0, 1]));
  const reader = new VectorBlockReader(resource, { path: "vectors/data.f32", count: 3, dimension: 2, bytes: 24 });
  const hits = await exactVectorSearch({
    reader, idMap: new MemoryIdMap(["doc-001", "doc-002", "doc-003"]), query: new Float32Array([1, 0]),
    collectionCount: 3, dimension: 2, search: { topK: 2, metric: "cosine", blockSize: 2 },
  });
  assert.deepEqual(hits.map(hit => hit.id), ["doc-001", "doc-002"]);
  assert.deepEqual(hits.map(hit => hit.row), [0, 1]);
  assert.equal(resource.calls.length, 2);
  assert.ok(hits[0].distance <= hits[1].distance);
});

test("exact search breaks equal-distance ties by global row", async () => {
  const resource = new MemoryResourceReader(encodeFloat32([1, 0, 0, 1, 1, 0]));
  const reader = new VectorBlockReader(resource, { path: "v", count: 3, dimension: 2, bytes: 24 });
  const hits = await exactVectorSearch({ reader, idMap: new MemoryIdMap([2, 1, 0]), query: new Float32Array([1, 1]), collectionCount: 3, dimension: 2, search: { topK: 3, metric: "cosine", blockSize: 1 } });
  assert.deepEqual(hits.map(hit => hit.row), [0, 1, 2]);
});

test("exact search rejects ID count mismatch and stops after cancellation", async () => {
  const resource = new MemoryResourceReader(encodeFloat32([1, 0, 0, 1]));
  const reader = new VectorBlockReader(resource, { path: "v", count: 2, dimension: 2, bytes: 16 });
  const badIds = new MemoryIdMap(["only-one"]); badIds.getIdsByRows = async () => [];
  await assert.rejects(exactVectorSearch({ reader, idMap: badIds, query: new Float32Array([1, 0]), collectionCount: 2, dimension: 2, search: { topK: 1, metric: "cosine", blockSize: 2 } }), { code: "RESOURCE_INTEGRITY_FAILED" });

  const controller = new AbortController();
  const cancellingIds = new MemoryIdMap(["a", "b"], () => controller.abort());
  await assert.rejects(exactVectorSearch({ reader, idMap: cancellingIds, query: new Float32Array([1, 0]), collectionCount: 2, dimension: 2, search: { topK: 1, metric: "cosine", blockSize: 1, signal: controller.signal } }), { code: "QUERY_CANCELLED" });
  assert.equal(resource.calls.length, 3); // one previous call plus both vector blocks before final ID resolution
});
