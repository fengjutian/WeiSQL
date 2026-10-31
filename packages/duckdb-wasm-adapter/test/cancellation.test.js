import assert from "node:assert/strict";
import test from "node:test";

import { createDuckDbWasmAdapter } from "../dist/index.js";

/**
 * A hand-written stand-in for `AsyncDuckDB`.
 *
 * The real engine runs queries synchronously inside the worker, so a test that
 * needs a *pending* query cannot use the blocking bindings. This fake lets the
 * adapter's abort race be tested deterministically.
 */
function fakeDatabase(overrides = {}) {
  const table = { toArray: () => [] };
  const connection = {
    query: async () => table,
    prepare: async () => ({ query: () => new Promise(() => {}), close: () => {} }),
    close: async () => {},
    cancelSent: async () => false,
    ...overrides.connection,
  };
  return {
    connect: async () => connection,
    registerFileBuffer: async () => {},
    dropFile: async () => {},
    tokenize: async () => ({ offsets: [0], types: [4] }),
    terminate: async () => {},
    ...overrides.database,
  };
}

const emptyManifest = { format: "weisql", formatVersion: "1.0.0", datasetId: "fake", tables: [], vectorCollections: [] };
const reader = { read: async () => new Uint8Array(), readRange: async () => new Uint8Array() };

test("aborting a running query rejects promptly and says the engine may still run", async () => {
  const adapter = createDuckDbWasmAdapter({ database: fakeDatabase() });
  await adapter.open({ manifest: emptyManifest, reader });

  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    adapter.query("SELECT 1", [], { signal: controller.signal }),
    (error) => error.code === "QUERY_CANCELLED" && error.details?.engineMayStillRun === true,
  );
  // The engine promise never settles; the adapter must not wait for it.
  assert.ok(Date.now() - started < 1000, "abort should not wait for the engine");
  await adapter.close();
});

test("a query that finishes before the abort returns its rows", async () => {
  const table = { toArray: () => [{ ok: 1 }] };
  const adapter = createDuckDbWasmAdapter({
    database: fakeDatabase({
      connection: {
        prepare: async () => ({ query: async () => table, close: () => {} }),
      },
    }),
  });
  await adapter.open({ manifest: emptyManifest, reader });
  const controller = new AbortController();
  assert.deepEqual(await adapter.query("SELECT 1 AS ok", [], { signal: controller.signal }), [{ ok: 1 }]);
  await adapter.close();
});
