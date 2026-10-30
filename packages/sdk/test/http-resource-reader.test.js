import assert from "node:assert/strict";
import test from "node:test";
import { HttpResourceReader } from "../dist/index.js";

const bytes = values => new Uint8Array(values);

test("reads a resource and resolves it below the package root", async () => {
  let request;
  const reader = new HttpResourceReader({
    baseUrl: "https://example.test/db",
    fetch: async (input, init) => {
      request = { url: String(input), init };
      return new Response(bytes([1, 2, 3]));
    },
  });
  assert.deepEqual([...await reader.read("data/file.bin")], [1, 2, 3]);
  assert.equal(request.url, "https://example.test/db/data/file.bin");
  assert.equal(request.init.method, "GET");
});

test("reads a valid half-open byte range", async () => {
  let rangeHeader;
  const reader = new HttpResourceReader({
    baseUrl: "https://example.test/db/",
    fetch: async (_input, init) => {
      rangeHeader = new Headers(init.headers).get("Range");
      return new Response(bytes([1, 2, 3, 4]), { status: 206, headers: { "Content-Range": "bytes 4-7/100" } });
    },
  });
  assert.deepEqual([...await reader.readRange("vectors/data.f32", { start: 4, end: 8 })], [1, 2, 3, 4]);
  assert.equal(rangeHeader, "bytes=4-7");
});

test("returns an empty range without fetching", async () => {
  let calls = 0;
  const reader = new HttpResourceReader({ baseUrl: "https://example.test/db/", fetch: async () => { calls++; return new Response(); } });
  assert.equal((await reader.readRange("data/file", { start: 8, end: 8 })).byteLength, 0);
  assert.equal(calls, 0);
});

test("rejects ignored, malformed, mismatched and short Range responses", async t => {
  const cases = [
    [new Response(bytes([1, 2, 3, 4]), { status: 200 }), "CORS_OR_RANGE_UNSUPPORTED"],
    [new Response(null, { status: 416 }), "INVALID_RANGE_RESPONSE"],
    [new Response(bytes([1, 2, 3, 4]), { status: 206 }), "INVALID_RANGE_RESPONSE"],
    [new Response(bytes([1, 2, 3, 4]), { status: 206, headers: { "Content-Range": "bytes 4-7/100" } }), "INVALID_RANGE_RESPONSE"],
    [new Response(bytes([1, 2]), { status: 206, headers: { "Content-Range": "bytes 0-3/100" } }), "RESOURCE_INTEGRITY_FAILED"],
  ];
  for (const [response, code] of cases) await t.test(code, async () => {
    const reader = new HttpResourceReader({ baseUrl: "https://example.test/db/", fetch: async () => response });
    await assert.rejects(reader.readRange("vectors/data.f32", { start: 0, end: 4 }), { code });
  });
});

test("rejects unsafe paths before fetching", async () => {
  let calls = 0;
  const reader = new HttpResourceReader({ baseUrl: "https://example.test/db/", fetch: async () => { calls++; return new Response(); } });
  await assert.rejects(reader.read("../secret.txt"), { code: "PATH_INVALID" });
  assert.equal(calls, 0);
});

test("maps HTTP, network, cancellation and closed lifecycle errors", async t => {
  await t.test("404", async () => {
    const reader = new HttpResourceReader({ baseUrl: "https://example.test/", fetch: async () => new Response(null, { status: 404 }) });
    await assert.rejects(reader.read("missing"), { code: "RESOURCE_NOT_FOUND" });
  });
  await t.test("network", async () => {
    const reader = new HttpResourceReader({ baseUrl: "https://example.test/", fetch: async () => { throw new TypeError("offline"); } });
    await assert.rejects(reader.read("file"), { code: "RESOURCE_READ_FAILED" });
  });
  await t.test("cancel", async () => {
    const controller = new AbortController(); controller.abort();
    const reader = new HttpResourceReader({ baseUrl: "https://example.test/", fetch: async () => { throw new DOMException("aborted", "AbortError"); } });
    await assert.rejects(reader.read("file", { signal: controller.signal }), { code: "QUERY_CANCELLED" });
  });
  await t.test("closed", async () => {
    const reader = new HttpResourceReader({ baseUrl: "https://example.test/", fetch: async () => new Response() });
    await reader.close(); await reader.close();
    await assert.rejects(reader.read("file"), { code: "DATABASE_CLOSED" });
  });
});

test("reads resource metadata and validates Content-Length", async () => {
  const reader = new HttpResourceReader({
    baseUrl: "https://example.test/db/",
    fetch: async () => new Response(null, { headers: { "Content-Length": "123", "Accept-Ranges": "bytes", ETag: "abc", "Last-Modified": "today" } }),
  });
  assert.deepEqual(await reader.stat("data/file"), { size: 123, etag: "abc", lastModified: "today", supportsRange: true });

  const invalid = new HttpResourceReader({ baseUrl: "https://example.test/db/", fetch: async () => new Response(null, { headers: { "Content-Length": "1.5" } }) });
  await assert.rejects(invalid.stat("data/file"), { code: "RESOURCE_READ_FAILED" });
});

test("enforces full-read and range response byte budgets before buffering", async t => {
  await t.test("rejects a declared full response above the budget", async () => {
    const reader = new HttpResourceReader({
      baseUrl: "https://example.test/",
      maxReadBytes: 3,
      fetch: async () => new Response(bytes([1, 2, 3, 4]), { headers: { "Content-Length": "4" } }),
    });
    await assert.rejects(reader.read("data/file"), { code: "RESOURCE_INTEGRITY_FAILED" });
  });

  await t.test("rejects an undeclared full response above the budget", async () => {
    const reader = new HttpResourceReader({
      baseUrl: "https://example.test/",
      maxReadBytes: 3,
      fetch: async () => new Response(bytes([1, 2, 3, 4])),
    });
    await assert.rejects(reader.read("data/file"), { code: "RESOURCE_INTEGRITY_FAILED" });
  });

  await t.test("rejects an oversized range before fetching", async () => {
    let calls = 0;
    const reader = new HttpResourceReader({
      baseUrl: "https://example.test/",
      maxRangeBytes: 3,
      fetch: async () => { calls++; return new Response(); },
    });
    await assert.rejects(reader.readRange("data/file", { start: 0, end: 4 }), { code: "RESOURCE_INTEGRITY_FAILED" });
    assert.equal(calls, 0);
  });

  await t.test("rejects a range Content-Length mismatch", async () => {
    const reader = new HttpResourceReader({
      baseUrl: "https://example.test/",
      fetch: async () => new Response(bytes([1, 2]), {
        status: 206,
        headers: { "Content-Range": "bytes 0-3/100", "Content-Length": "2" },
      }),
    });
    await assert.rejects(reader.readRange("data/file", { start: 0, end: 4 }), { code: "INVALID_RANGE_RESPONSE" });
  });
});

test("rejects invalid HTTP response budgets during construction", () => {
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => new HttpResourceReader({ baseUrl: "https://example.test/", maxReadBytes: value }), { code: "INVALID_ARGUMENT" });
    assert.throws(() => new HttpResourceReader({ baseUrl: "https://example.test/", maxRangeBytes: value }), { code: "INVALID_ARGUMENT" });
  }
});
