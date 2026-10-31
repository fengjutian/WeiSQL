# @weisql/duckdb-wasm-adapter

Read-only [DuckDB-Wasm](https://duckdb.org/docs/api/wasm/overview) `SqlAdapter`
for WeiSQL AI in the browser.

```ts
import { open, HttpResourceReader } from "@weisql/sdk";
import { createDuckDbWasmAdapter } from "@weisql/duckdb-wasm-adapter";

const db = await open({
  manifestUrl: "/datasets/demo/manifest.json",
  resourceReader: new HttpResourceReader({ baseUrl: "/datasets/demo/" }),
  sqlAdapter: createDuckDbWasmAdapter({
    bundles: {
      mainModule: "/vendor/duckdb/duckdb-eh.wasm",
      mainWorker: "/vendor/duckdb/duckdb-browser-eh.worker.js",
    },
    extensionRepository: `${location.origin}/extensions`,
  }),
});

const rows = await db.sql("select id, title from documents where category = ?", ["genetics"]);
```

## What it does

- Creates an `AsyncDuckDB` worker, loads the `parquet` extension, and
  materializes each Manifest table from bytes that the SDK's `ResourceReader`
  fetched (and, if requested, verified). DuckDB never downloads the package.
- Runs only `SELECT`/`EXPLAIN`/`DESCRIBE`/`SHOW`/`SUMMARIZE`/`PIVOT`/`UNPIVOT`/
  `TABLE`/`VALUES` statements. `WITH` is rejected: DuckDB-Wasm exposes no
  prepared-statement classification, so a leading-keyword allow-list is the
  boundary that cannot be bypassed through a CTE.
- Disables external file access (`enable_external_access=false`) and locks the
  configuration after setup.
- Verifies the materialized schema against the Manifest (L4) by default.

## Serving the parquet extension

DuckDB-Wasm downloads `parquet` from `extensions.duckdb.org`, which does not
send CORS headers, so a page cannot fetch it cross-origin. Host the extension
on the same origin as the app and point `extensionRepository` at it:

```bash
node tools/fetch-duckdb-wasm-extension.mjs   # writes .cache/duckdb-wasm-extensions/<version>/wasm_eh/
```

The version is read from the bundled WASM module, so the extension always
matches the engine. See `docs/DUCKDB_WASM_ADAPTER.md` for the full contract and
the known limitations (parameters are JSON scalars, cancellation is
best-effort, no `WITH`).

## Limitations

| Area | Behaviour |
| --- | --- |
| CTEs | `WITH ...` is rejected with `SQL_UNSUPPORTED` |
| Parameters | `string`, `number`, `boolean`, `null`, and safe-range `bigint` only; `Date`/binary are rejected |
| Cancellation | `best-effort`; the worker may finish the current task |
| Memory | Parquet bytes plus a materialized table per Manifest table, bounded by `maxTableBytes` (default 256 MiB) |
| Extension | One network/CORS dependency unless self-hosted via `extensionRepository` |

Apache-2.0.
