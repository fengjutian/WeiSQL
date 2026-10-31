import assert from "node:assert/strict";
import test from "node:test";

import { createDuckDbWasmAdapter } from "../dist/index.js";

const emptyManifest = { format: "weisql", formatVersion: "1.0.0", datasetId: "fake", tables: [], vectorCollections: [] };
const reader = { read: async () => new Uint8Array(), readRange: async () => new Uint8Array() };

/** A database whose `INSTALL parquet` fails, as it does without network/CORS. */
function databaseThatCannotInstallParquet() {
  const table = { toArray: () => [] };
  return {
    connect: async () => ({
      query: async (sql) => {
        if (sql.startsWith("INSTALL parquet")) {
          throw new Error(
            "Extension https://extensions.duckdb.org/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm is not available",
          );
        }
        return table;
      },
      prepare: async () => ({ query: async () => table, close: () => {} }),
      close: async () => {},
      cancelSent: async () => false,
    }),
    registerFileBuffer: async () => {},
    dropFile: async () => {},
    tokenize: async () => ({ offsets: [0], types: [4] }),
    terminate: async () => {},
  };
}

test("a missing parquet extension fails open() with a stable, actionable error", async () => {
  const adapter = createDuckDbWasmAdapter({ database: databaseThatCannotInstallParquet() });
  await assert.rejects(adapter.open({ manifest: emptyManifest, reader }), (error) => {
    assert.equal(error.code, "SQL_UNSUPPORTED");
    assert.equal(error.details?.phase, "extension");
    assert.equal(adapter.state, "FAILED");
    return true;
  });
});

test("an injected database without a tokenizer stays on the strict allow-list", async () => {
  const table = { toArray: () => [] };
  const database = {
    connect: async () => ({
      query: async () => table,
      prepare: async () => ({ query: async () => table, close: () => {} }),
      close: async () => {},
      cancelSent: async () => false,
    }),
    registerFileBuffer: async () => {},
    dropFile: async () => {},
    terminate: async () => {},
  };
  const adapter = createDuckDbWasmAdapter({ database });
  await adapter.open({ manifest: emptyManifest, reader });
  assert.equal(adapter.capabilities.supportedFeatures.includes("cte"), false);
  await assert.rejects(
    adapter.query("WITH x AS (SELECT 1) SELECT * FROM x"),
    (error) => error.code === "SQL_UNSUPPORTED" && /CTEs/.test(error.message),
  );
  await adapter.close();
});
