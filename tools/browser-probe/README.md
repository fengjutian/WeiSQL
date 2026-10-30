# Browser probe

Runs the built SDK in a real Chromium against the example package served over
HTTP with CORS and byte ranges. It answers one question that unit tests cannot:
does the browser path actually work end to end?

```bash
npm run build
npm run probe:browser
```

The command exits non-zero when the probe fails.

## What it verifies

1. The built ESM bundle loads in a browser (`packages/sdk/dist`, no bundler).
2. `HttpResourceReader` performs real `Range` requests and validates `206` and
   `Content-Range`.
3. `verifyChecksums: "all"` verifies sizes and SHA-256 with the SDK's
   zero-dependency hasher.
4. Exact vector search plus ID Map join returns `doc-001`, `doc-002`, `doc-003`
   with distances `0`, `0.006116`, `1`.
5. A repeated search is served from `CachedResourceReader`.
6. No Node-only globals (`process`, `Buffer`) leak into the browser bundle.

The server records every request, so the output proves the package was read in
ranges rather than downloaded whole.

## Requirements

- `playwright-core` (devDependency)
- Any Chromium-based binary: a Playwright browser cache, system Chrome, or Edge.
  Override with `CHROME_PATH`.

## Why this probe found a real bug

The first run failed with `TypeError: Failed to execute 'fetch' on 'Window':
Illegal invocation`. `globalThis.fetch` was being called as a detached function,
which browsers reject and Node's undici tolerates. Unit tests could not catch it;
`packages/sdk/test/fetch-binding.test.js` now pins the receiver for both entry
points.

## Known blocker: DuckDB-Wasm needs a downloadable extension

`@duckdb/duckdb-wasm` instantiates fine in the same browser (577 ms), and the
Parquet URL can be registered, but `read_parquet` downloads
`parquet.duckdb_extension.wasm` from `extensions.duckdb.org`. That host was
unreachable from this environment, so the browser SQL path could not be verified.

Unless the extension can be fetched or self-hosted, this repository cannot claim
DuckDB-Wasm support. See ADR-020 in `docs/DECISION_LOG.md`.
