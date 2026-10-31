/**
 * Adapts the synchronous `@duckdb/duckdb-wasm/blocking` bindings to the small
 * async surface the adapter consumes.
 *
 * Why not use the browser `AsyncDuckDB` here: it needs a `Worker`, and Node's
 * `worker_threads.Worker` does not implement the Web Worker event interface
 * that DuckDB-Wasm expects. The blocking bindings run the same WASM engine in
 * the same thread, so the SQL behaviour under test is the real thing.
 */
import { createRequire } from "node:module";

import { createDuckDB, NODE_RUNTIME, VoidLogger } from "@duckdb/duckdb-wasm/blocking";
import { tableFromIPC } from "apache-arrow";

const require = createRequire(import.meta.url);

export async function createWasmTestDatabase() {
  const ehModule = require.resolve("@duckdb/duckdb-wasm/dist/duckdb-eh.wasm");
  const mvpModule = require.resolve("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm");
  const bindings = await createDuckDB(
    {
      mvp: { mainModule: mvpModule, mainWorker: null },
      eh: { mainModule: ehModule, mainWorker: null },
    },
    new VoidLogger(),
    NODE_RUNTIME,
  );
  await bindings.instantiate();
  bindings.open({});

  const wrapTable = (data) => {
    const table = tableFromIPC(data);
    return { toArray: () => table.toArray() };
  };

  return {
    connect() {
      const connection = bindings.connect();
      const connectionId = connection.useUnsafe((_bindings, id) => id);
      return {
        query(sql) {
          return Promise.resolve(wrapTable(connection.useUnsafe((b, id) => b.runQuery(id, sql))));
        },
        async prepare(sql) {
          const statementId = connection.useUnsafe((b, id) => b.createPrepared(id, sql));
          return {
            query: (...params) =>
              Promise.resolve(wrapTable(connection.useUnsafe((b, id) => b.runPrepared(id, statementId, params)))),
            close: () => Promise.resolve(connection.useUnsafe((b, id) => b.closePrepared(id, statementId))),
          };
        },
        close() {
          bindings.disconnect(connectionId);
          return Promise.resolve();
        },
        cancelSent() {
          return Promise.resolve(false);
        },
      };
    },
    registerFileBuffer(name, buffer) {
      bindings.registerFileBuffer(name, buffer);
      return Promise.resolve();
    },
    dropFile(name) {
      bindings.dropFile(name);
      return Promise.resolve();
    },
    terminate() {
      return Promise.resolve();
    },
  };
}
