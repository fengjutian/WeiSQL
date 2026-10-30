import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { HttpResourceReader, open } from "../dist/index.js";

/**
 * Browsers throw "Illegal invocation" when `fetch` is called as a bare
 * function. Node's undici does not, so only a receiver-checking stub and a real
 * browser expose the bug. This test pins the binding for both entry points.
 */
function strictFetch(calls, respond) {
  return function strict(url, init) {
    calls.push({ receiver: this, url: String(url) });
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    return respond(url, init);
  };
}

test("HttpResourceReader binds the injected fetch to the global receiver", async () => {
  const calls = [];
  const reader = new HttpResourceReader({
    baseUrl: "https://example.test/demo/",
    fetch: strictFetch(calls, async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "Content-Length": "3" },
    })),
  });
  const bytes = await reader.read("data/table.parquet");
  assert.deepEqual([...bytes], [1, 2, 3]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].receiver, globalThis);
  assert.equal(calls[0].url, "https://example.test/demo/data/table.parquet");
  await reader.close();
});

test("open({ manifestUrl }) binds the injected fetch to the global receiver", async () => {
  const manifest = JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
  const calls = [];
  const db = await open({
    manifestUrl: "https://example.test/demo/manifest.json",
    fetch: strictFetch(calls, async () => new Response(JSON.stringify(manifest), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })),
  });
  assert.equal(db.state, "READY");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].receiver, globalThis);
  await db.close();
});
