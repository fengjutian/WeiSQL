import assert from "node:assert/strict";
import test from "node:test";

import { StreamingContainerReader, createBytesContainerSource, createContainer, createHttpContainerSource } from "../dist/index.js";

const encoder = new TextEncoder();

async function sample() {
  return createContainer([
    { path: "manifest.json", bytes: encoder.encode('{"format":"weisql"}\n') },
    { path: "vectors/embeddings.f32", bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) },
    { path: "data/table.parquet", bytes: new Uint8Array(64).fill(7) },
  ]);
}

/** Response-like object: only the members the source uses. */
function response({ status, body, headers }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(headers),
    async arrayBuffer() {
      return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    },
  };
}

function rangeFetch(bytes, { ignoreRange = false } = {}) {
  const calls = [];
  const fetcher = async (_url, init = {}) => {
    const range = init.headers?.Range ?? init.headers?.range;
    calls.push(range ?? null);
    if (ignoreRange || range === undefined) {
      return response({ status: 200, body: bytes, headers: [["content-length", String(bytes.byteLength)]] });
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    assert.ok(match, `unexpected range ${range}`);
    const start = Number(match[1]);
    const end = Number(match[2]);
    return response({
      status: 206,
      body: bytes.slice(start, end + 1),
      headers: [["content-range", `bytes ${start}-${end}/${bytes.byteLength}`]],
    });
  };
  return { fetcher, calls };
}

test("streams a container through a byte source without loading it whole", async () => {
  const bytes = await sample();
  const reader = await StreamingContainerReader.open(createBytesContainerSource(bytes));
  assert.deepEqual(reader.header.files.map(entry => entry.path), ["manifest.json", "vectors/embeddings.f32", "data/table.parquet"]);

  const manifest = await reader.read("manifest.json");
  assert.equal(new TextDecoder().decode(manifest), '{"format":"weisql"}\n');
  assert.deepEqual([...await reader.readRange("vectors/embeddings.f32", { start: 2, end: 5 })], [3, 4, 5]);
  assert.deepEqual(await reader.stat("data/table.parquet"), { size: 64, supportsRange: true });
  assert.deepEqual(await reader.verify(), []);

  await assert.rejects(reader.read("missing.txt"), { code: "INDEX_NOT_FOUND" });
  await assert.rejects(reader.readRange("vectors/embeddings.f32", { start: 4, end: 99 }), { code: "RESOURCE_INTEGRITY_FAILED" });
  await reader.close();
  await assert.rejects(reader.read("manifest.json"), { code: "DATABASE_CLOSED" });
});

test("HTTP source discovers the size with Content-Range and reads exact ranges", async () => {
  const bytes = await sample();
  const { fetcher, calls } = rangeFetch(bytes);
  const source = createHttpContainerSource({ url: "https://example.test/pkg.wsql", fetch: fetcher });
  assert.equal(await source.size(), bytes.byteLength);
  assert.equal(calls[0], "bytes=0-0");

  const reader = await StreamingContainerReader.open(source);
  const range = await reader.readRange("data/table.parquet", { start: 10, end: 20 });
  assert.equal(range.byteLength, 10);
  assert.deepEqual([...range], new Array(10).fill(7));
  assert.deepEqual(await reader.verify(), []);
});

test("HTTP source falls back when the host ignores Range", async () => {
  const bytes = await sample();
  const { fetcher } = rangeFetch(bytes, { ignoreRange: true });
  const source = createHttpContainerSource({ url: "https://example.test/pkg.wsql", fetch: fetcher });
  assert.equal(await source.size(), bytes.byteLength);

  const reader = await StreamingContainerReader.open(source);
  const manifest = await reader.read("manifest.json");
  assert.equal(new TextDecoder().decode(manifest), '{"format":"weisql"}\n');
  assert.deepEqual([...await reader.readRange("vectors/embeddings.f32", { start: 0, end: 3 })], [1, 2, 3]);
});

test("streaming open rejects truncated containers and bad sources", async () => {
  const bytes = await sample();
  const truncated = {
    async size() { return 10; },
    async readRange() { throw new Error("should not read"); },
  };
  await assert.rejects(StreamingContainerReader.open(truncated), { code: "RESOURCE_INTEGRITY_FAILED" });

  const shortPrefix = {
    async size() { return bytes.byteLength; },
    async readRange() { return new Uint8Array(4); },
  };
  await assert.rejects(StreamingContainerReader.open(shortPrefix), { code: "RESOURCE_INTEGRITY_FAILED" });

  const hostileMagic = {
    async size() { return bytes.byteLength; },
    async readRange(range) {
      const copy = bytes.slice(range.start, range.end);
      if (range.start === 0) copy.set([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8], 0);
      return copy;
    },
  };
  await assert.rejects(StreamingContainerReader.open(hostileMagic), { code: "RESOURCE_INTEGRITY_FAILED" });
});
