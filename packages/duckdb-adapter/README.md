# @weisql/duckdb-adapter

Read-only DuckDB `SqlAdapter` for WeiSQL AI (Node.js). The SDK itself stays
engine-free; this package provides the engine and is injected at runtime.

```ts
import { open, NodeFileResourceReader } from "@weisql/sdk";
import { createDuckDbAdapter } from "@weisql/duckdb-adapter";

const db = await open({
  manifestUrl: "./demo/manifest.json",
  resourceReader: new NodeFileResourceReader({ rootDirectory: "./demo" }),
  sqlAdapter: createDuckDbAdapter(),
});

const rows = await db.sql("select id, title from documents where category = ?", ["genetics"]);
```

## What it guarantees

- Only `SELECT` and `EXPLAIN` prepared statements run; writes, DDL, `SET`, `CALL`
  and multi-statement input are rejected with `SQL_UNSUPPORTED`.
- Values are bound as parameters, never interpolated.
- Manifest columns and types are compared with the Parquet file (L4).
- `AbortSignal` interrupts a running query via `connection.interrupt()`.

## Deliberate trade-off: tables are loaded before querying

`tableLoading: "memory"` (default) copies each table into an in-memory DuckDB
table and then disables external file access, which is what stops
`read_parquet('/etc/passwd')` inside user SQL. Memory cost equals the table size
and is capped by `maxTableBytes` (256 MiB by default).

`tableLoading: "lazy"` keeps views over extracted files so memory stays bounded,
but external file access must stay enabled — only use it when the SQL is written
by the application, not by end users.

Full rationale and measurements: [`docs/DUCKDB_ADAPTER.md`](../../docs/DUCKDB_ADAPTER.md)
and [`docs/TABLE_LOADING_OPTIONS.md`](../../docs/TABLE_LOADING_OPTIONS.md).

## Requirements

Node.js 20+ with a `@duckdb/node-api` prebuilt binding for your platform.
