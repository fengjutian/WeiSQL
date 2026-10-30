import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CachedResourceReader, open } from "../dist/index.js";

/** Records calls and supports delay, failure, short reads and abort observation. */
class FakeReader {
  constructor(options = {}) {
    this.files = options.files ?? new Map();
    this.delayMs = options.delayMs ?? 0;
    this.failOn = options.failOn ?? new Set();
    this.shortRead = options.shortRead === true;
    this.calls = [];
    this.abortedCalls = 0;
    this.active = 0;
    this.maxActive = 0;
    this.closed = false;
  }
  callCount(path) {
    return this.calls.filter(call => call.path === path).length;
  }
  async readRange(path, range, options) {
    this.calls.push({ path, start: range.start, end: range.end });
    this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    const signal = options?.signal;
    try {
      await new Promise((resolve, reject) => {
        if (signal?.aborted) {
          this.abortedCalls++;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        const timer = setTimeout(resolve, this.delayMs);
        signal?.addEventListener("abort", () => {
          this.abortedCalls++;
          clearTimeout(timer);
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      });
      if (this.failOn.has(path)) throw new Error("boom");
      const data = this.files.get(path) ?? new Uint8Array(range.end);
      const slice = data.slice(range.start, range.end);
      return this.shortRead ? slice.subarray(0, Math.max(0, slice.length - 1)) : slice;
    } finally {
      this.active--;
    }
  }
  async read(path) {
    return this.files.get(path) ?? new Uint8Array(0);
  }
  async stat(path) {
    const data = this.files.get(path);
    return data === undefined ? { size: 0 } : { size: data.byteLength, supportsRange: true };
  }
  async close() {
    this.closed = true;
  }
}

function bytes(...values) {
  return Uint8Array.from(values);
}

function cached(reader, options = {}) {
  return new CachedResourceReader({ reader, ...options });
}

test("repeated identical ranges are served from the cache", async () => {
  const reader = new FakeReader({ files: new Map([["v.f32", bytes(1, 2, 3, 4, 5, 6, 7, 8)]]) });
  const cache = cached(reader);
  const first = await cache.readRange("v.f32", { start: 0, end: 4 });
  const second = await cache.readRange("v.f32", { start: 0, end: 4 });
  assert.deepEqual([...first], [1, 2, 3, 4]);
  assert.deepEqual([...second], [1, 2, 3, 4]);
  assert.equal(reader.callCount("v.f32"), 1);
  assert.notEqual(first, second, "cache hits must not hand out the stored buffer");
  first[0] = 99;
  assert.deepEqual([...(await cache.readRange("v.f32", { start: 0, end: 4 }))], [1, 2, 3, 4]);
  const stats = cache.stats();
  assert.equal(stats.hits, 2);
  assert.equal(stats.misses, 1);
  assert.equal(stats.entries, 1);
  assert.equal(stats.cachedBytes, 4);
  await cache.close();
});

test("different ranges are cached separately", async () => {
  const reader = new FakeReader({ files: new Map([["v.f32", bytes(1, 2, 3, 4, 5, 6, 7, 8)]]) });
  const cache = cached(reader);
  await cache.readRange("v.f32", { start: 0, end: 4 });
  await cache.readRange("v.f32", { start: 4, end: 8 });
  assert.equal(reader.callCount("v.f32"), 2);
  assert.equal(cache.stats().entries, 2);
  assert.equal(cache.stats().cachedBytes, 8);
  await cache.close();
});

test("eviction keeps the cache inside the byte budget", async () => {
  const reader = new FakeReader({ files: new Map([["v.f32", bytes(1, 2, 3, 4, 5, 6, 7, 8)]]) });
  const cache = cached(reader, { maxCacheBytes: 8, maxEntryBytes: 8 });
  await cache.readRange("v.f32", { start: 0, end: 4 });
  await cache.readRange("v.f32", { start: 4, end: 8 });
  await cache.readRange("v.f32", { start: 2, end: 6 });
  const stats = cache.stats();
  assert.equal(stats.entries, 2);
  assert.equal(stats.cachedBytes, 8);
  assert.equal(stats.evictions, 1);
  // The first entry was evicted, so it is read again.
  await cache.readRange("v.f32", { start: 0, end: 4 });
  assert.equal(reader.callCount("v.f32"), 4);
  await cache.close();
});

test("ranges above maxEntryBytes bypass the cache", async () => {
  const reader = new FakeReader({ files: new Map([["v.f32", bytes(1, 2, 3, 4)]]) });
  const cache = cached(reader, { maxEntryBytes: 2 });
  await cache.readRange("v.f32", { start: 0, end: 4 });
  await cache.readRange("v.f32", { start: 0, end: 4 });
  assert.equal(reader.callCount("v.f32"), 2);
  const stats = cache.stats();
  assert.equal(stats.bypasses, 2);
  assert.equal(stats.entries, 0);
  await cache.close();
});

test("concurrent identical ranges are coalesced", async () => {
  const reader = new FakeReader({ files: new Map([["v.f32", bytes(9, 8, 7, 6)]]), delayMs: 20 });
  const cache = cached(reader);
  const [a, b] = await Promise.all([
    cache.readRange("v.f32", { start: 0, end: 4 }),
    cache.readRange("v.f32", { start: 0, end: 4 }),
  ]);
  assert.deepEqual([...a], [9, 8, 7, 6]);
  assert.deepEqual([...b], [9, 8, 7, 6]);
  assert.equal(reader.callCount("v.f32"), 1);
  assert.equal(cache.stats().coalesced, 1);
  await cache.close();
});

test("one cancelled waiter keeps the shared read alive for the others", async () => {
  const reader = new FakeReader({ files: new Map([["v.f32", bytes(1, 2, 3, 4)]]), delayMs: 40 });
  const cache = cached(reader);
  const controller = new AbortController();
  const cancelled = cache.readRange("v.f32", { start: 0, end: 4 }, { signal: controller.signal });
  const survivor = cache.readRange("v.f32", { start: 0, end: 4 });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(cancelled, { code: "QUERY_CANCELLED" });
  assert.deepEqual([...(await survivor)], [1, 2, 3, 4]);
  assert.equal(reader.abortedCalls, 0, "the underlying read must not be aborted while a waiter remains");
  assert.equal(reader.callCount("v.f32"), 1);
  await cache.close();
});

test("the underlying read is aborted only after every waiter cancels", async () => {
  const reader = new FakeReader({ files: new Map([["v.f32", bytes(1, 2, 3, 4)]]), delayMs: 60 });
  const cache = cached(reader);
  const first = new AbortController();
  const second = new AbortController();
  const a = cache.readRange("v.f32", { start: 0, end: 4 }, { signal: first.signal });
  const b = cache.readRange("v.f32", { start: 0, end: 4 }, { signal: second.signal });
  setTimeout(() => { first.abort(); second.abort(); }, 5);
  await assert.rejects(a, { code: "QUERY_CANCELLED" });
  await assert.rejects(b, { code: "QUERY_CANCELLED" });
  assert.equal(reader.abortedCalls, 1);
  assert.equal(cache.stats().entries, 0, "an aborted read must not populate the cache");

  // The entry was cleaned up, so the next read starts a fresh request.
  assert.deepEqual([...(await cache.readRange("v.f32", { start: 0, end: 4 }))], [1, 2, 3, 4]);
  assert.equal(reader.callCount("v.f32"), 2);
  await cache.close();
});

test("failed and short reads are never cached", async () => {
  const failing = new FakeReader({ files: new Map([["v.f32", bytes(1, 2, 3, 4)]]), failOn: new Set(["v.f32"]) });
  const failCache = cached(failing);
  await assert.rejects(failCache.readRange("v.f32", { start: 0, end: 4 }), /boom/);
  await assert.rejects(failCache.readRange("v.f32", { start: 0, end: 4 }), /boom/);
  assert.equal(failing.callCount("v.f32"), 2);
  assert.equal(failCache.stats().entries, 0);
  await failCache.close();

  const short = new FakeReader({ files: new Map([["v.f32", bytes(1, 2, 3, 4)]]), shortRead: true });
  const shortCache = cached(short);
  const shortened = await shortCache.readRange("v.f32", { start: 0, end: 4 });
  assert.equal(shortened.byteLength, 3);
  assert.equal(shortCache.stats().entries, 0);
  await shortCache.readRange("v.f32", { start: 0, end: 4 });
  assert.equal(short.callCount("v.f32"), 2);
  await shortCache.close();
});

test("publication version changes invalidate the cache", async () => {
  const reader = new FakeReader({ files: new Map([["v.f32", bytes(1, 2, 3, 4)]]) });
  const cache = cached(reader, { version: "release-1" });
  await cache.readRange("v.f32", { start: 0, end: 4 });
  await cache.readRange("v.f32", { start: 0, end: 4 });
  assert.equal(reader.callCount("v.f32"), 1);
  cache.setPublicationVersion("release-2");
  assert.equal(cache.stats().entries, 0);
  await cache.readRange("v.f32", { start: 0, end: 4 });
  assert.equal(reader.callCount("v.f32"), 2);
  await cache.close();
});

test("concurrent underlying reads respect maxConcurrentReads", async () => {
  const files = new Map([
    ["a", bytes(1)],
    ["b", bytes(2)],
    ["c", bytes(3)],
    ["d", bytes(4)],
    ["e", bytes(5)],
  ]);
  const reader = new FakeReader({ files, delayMs: 20 });
  const cache = cached(reader, { maxConcurrentReads: 2 });
  await Promise.all([...files.keys()].map(path => cache.readRange(path, { start: 0, end: 1 })));
  assert.equal(reader.maxActive, 2);
  assert.equal(reader.calls.length, 5);
  await cache.close();
});

test("close is idempotent, closes the inner reader and rejects later reads", async () => {
  const reader = new FakeReader({ files: new Map([["v.f32", bytes(1, 2, 3, 4)]]) });
  const cache = cached(reader);
  await cache.readRange("v.f32", { start: 0, end: 4 });
  await cache.close();
  await cache.close();
  assert.equal(reader.closed, true);
  await assert.rejects(cache.readRange("v.f32", { start: 0, end: 4 }), { code: "DATABASE_CLOSED" });
});

test("open({ cache }) wires the cache into vector search", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
  const floats = new Uint8Array(6 * 4);
  const view = new DataView(floats.buffer);
  [1, 0, 0.9, 0.1, 0, 1].forEach((value, index) => view.setFloat32(index * 4, value, true));
  const idData = new TextEncoder().encode('{"row":0,"id":"doc-001"}\n{"row":1,"id":"doc-002"}\n{"row":2,"id":"doc-003"}\n');
  const offsets = new Uint8Array(3 * 8);
  const offsetView = new DataView(offsets.buffer);
  [0, 25, 50].forEach((value, index) => offsetView.setBigUint64(index * 8, BigInt(value), true));
  const reader = new FakeReader({ files: new Map([
    ["vectors/embeddings.f32", floats],
    ["vectors/id-map.jsonl", idData],
    ["vectors/id-map.offsets", offsets],
  ]) });

  const db = await open({ manifest, resourceReader: reader, cache: { maxCacheBytes: 1024 * 1024 } });
  const first = await db.vector.search("document_embeddings", [1, 0], { topK: 2 });
  const second = await db.vector.search("document_embeddings", [1, 0], { topK: 2 });
  assert.deepEqual(first.map(hit => hit.id), second.map(hit => hit.id));
  assert.equal(reader.callCount("vectors/embeddings.f32"), 1, "the second search should hit the cache");
  await db.close();
  assert.equal(reader.closed, true);
});
