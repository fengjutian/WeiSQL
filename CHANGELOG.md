# Changelog

All notable changes to the WeiSQL AI packages. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

Nothing has been published to a registry yet, so every entry below is unreleased.

## [Unreleased]

### `@weisql/sdk` 0.1.0

- Manifest V1 validation (L1/L2) with path, uniqueness and cross-field rules.
- L3 resource integrity: `verifyChecksums` modes `none` / `manifest` / `all`,
  streaming SHA-256 and ID Map content checks.
- `HttpResourceReader` and `NodeFileResourceReader` with strict Range handling,
  root containment and cancellation.
- `CachedResourceReader`: bounded LRU, request coalescing, publication-version
  isolation and hit statistics.
- Runtime: dual Manifest sources, lifecycle state machine, `capabilities()`,
  idempotent `close()`, `SqlAdapter` / `VectorAdapter` injection.
- `QueryOptions.maxRows`: an explicit row budget for `db.sql()`; adapters reject
  with `INVALID_ARGUMENT` instead of truncating.
- `db.sqlStream()`: `AsyncIterable` rows via an optional adapter `stream` path,
  with a `query()` fallback when an adapter has no streaming implementation.
- Exact vector search, ID Map join, stable Top-K and the `exact-filter-first`
  and `vector-first` hybrid strategies.
- `buildPackage()` Builder: writes vectors, ID Map, real digests and Manifest,
  verifies the staged package, then publishes atomically.
- `createExactVectorAdapter()` reference `VectorAdapter` implementation.
- Full-text: `textIndexes` Manifest field, BM25 scoring, `tokenize()`,
  `TextIndexReader` and the public `db.text.search()` (higher score = better,
  the opposite of vector distance).
- Hybrid fusion: `db.hybrid.search()` combining vector and text rankings with
  Reciprocal Rank Fusion, reporting per-source ranks and raw values.
- Filters support membership (`IN`), ranges and `ne`, plus `date`/`timestamp`
  values; `json` equality is still rejected explicitly.
- Exact filtered search reads only the allowed vector rows, merging contiguous
  rows into one read, and picks between that and a sequential scan with a
  request-aware cost model (scattered filters used to issue thousands of reads).
- Vector collections carry an optional sorted `id → row` index; filtered search
  loads it once and binary-searches instead of scanning the whole ID Map. L3
  verifies its bytes and, in `all` mode, that it is a sorted row permutation.
- Manifest signing supports multiple signatures (`signatures`), co-signing via
  `countersignManifest()` / `weisql sign --add`, and key rotation without breaking
  consumers pinned to the old key. Verifiers can require n pinned signers
  (`minimumTrustedSignatures` / `--require`). A root key can authorize release
  keys with a validity window (`authorizeSigner()` / `trustedRootKeyIds`), and the
  CLI adds `authorize` plus `--trusted-root` for `validate`/`verify-signature`.
- Manifest signing: Ed25519 over canonical JSON, `signManifest()` /
  `verifyManifestSignature()` with optional pinned key ids; `buildPackage()`
  signs during the build when a key pair is supplied.
- RAG retrieval: `db.rag.search()` assembling budgeted evidence with provenance;
  the SDK never calls a model.
- `.wsql` single-file container: `createContainer()`, `parseContainer()`,
  `ContainerReader` and `StreamingContainerReader` with an HTTP Range source.
- Container format 1.1.0: optional per-entry gzip (`compress: true`), with
  digests computed over the decompressed content.

### `@weisql/cli` 0.1.0

- `weisql validate <dir|file.wsql>` with `--mode` / `--json` and exit codes 0/1/2.
- `weisql pack <dir> --output <file>` produces a `.wsql` container; validating a
  container checks both the container digests and the Manifest resources.
- `weisql pack --compress` writes a gzip container (format 1.1.0) that still
  validates, unpacks and streams.
- `weisql unpack <file.wsql>` verifies every digest before writing anything, and
  rejects entry paths that could escape the output directory.
- `weisql validate --l4` verifies Parquet content against the Manifest through an
  optional `@weisql/duckdb-adapter` peer; works for directories and containers.
- `weisql keygen`, `weisql sign` and `weisql verify-signature` sign directories or
  `.wsql` containers; `validate --signature [--trusted <keyId>]` gates on them.
- `weisql inspect` summarizes a package and lists undeclared files; `pack
  --only-declared` refuses to ship anything the Manifest does not declare.

### `@weisql/duckdb-adapter` 0.1.0

- Read-only DuckDB adapter: statement-type enforcement, parameter binding,
  L4 schema verification, native interruption.
- `db.sql(..., { maxRows })` rejects oversized results with `INVALID_ARGUMENT`
  instead of truncating; plain `SELECT` is rewritten with `LIMIT maxRows + 1` so
  the engine stops early, while classification still runs on the original
  statement.
- `db.sqlStream()` streams chunks via `prepared.stream()`, with the same
  read-only guard and row budget as `sql()`. Cancellation races each chunk read
  against the signal, so aborting rejects without waiting for the pending read.
- `tableLoading: "memory" | "lazy"` with the security/memory trade-off documented.
- Two-level declared-byte budget: `maxTableBytes` (default 256 MiB) per table and
  `maxTotalTableBytes` (default 512 MiB) per package, checked before the DuckDB
  instance is created.

### `@weisql/duckdb-wasm-adapter` 0.1.0

- Read-only DuckDB-Wasm `SqlAdapter` for browsers: worker-based `AsyncDuckDB`,
  tables materialized from `ResourceReader` bytes, L4 schema verification.
- Read-only enforced with a leading-keyword allow-list; `WITH` is classified with
  DuckDB's tokenizer, so read-only CTEs (including recursive ones) work while
  `WITH ... DELETE/INSERT/UPDATE` is rejected. Without a tokenizer the stricter
  allow-list applies and `WITH` is refused (`supportedFeatures` omits `cte`).
- Tokenizer offsets are UTF-8 bytes, not JavaScript indices; they are translated
  before slicing so Chinese literals cannot shift a keyword classification.
- Parameter binding via prepared statements, limited to values the JSON binding
  can carry; `Date`, binary and out-of-range `bigint` are rejected.
- `db.sql(..., { maxRows })` matches the Node adapter: `SELECT`/`VALUES`/`TABLE`
  are wrapped with `LIMIT maxRows + 1` and oversized results raise
  `INVALID_ARGUMENT`; metadata statements are checked after execution.
- `db.sqlStream()` consumes `prepared.send()` Arrow batches, so rows arrive
  before the whole result is materialized; the Chromium probe asserts it.
- `DECIMAL` is cast to `DOUBLE` (`castDecimalToDouble`) so results are numbers,
  matching the Node adapter instead of leaking Arrow's unscaled words; `BIGINT`
  stays a `bigint`.
- Self-hosted parquet extension (`extensionRepository`); `extensions.duckdb.org`
  sends no CORS headers, so cross-origin loading fails by design.
- Default table budget is 64 MiB in the browser (the Node adapter keeps 256 MiB):
  materialization costs roughly four times the Parquet size, so 256 MiB would
  allow ~1 GiB of browser memory. `maxTableBytes` stays overridable.
- `maxTotalTableBytes` (default 128 MiB) caps a whole package's declared table
  bytes before the WASM module or extension is loaded; a per-table limit alone
  let ten tables ask for ten times the memory.
- `capabilities()` reports `engine: "duckdb-wasm"` and `cancellation: "best-effort"`.
  Aborting a running query rejects the caller immediately with
  `QUERY_CANCELLED` and `details.engineMayStillRun: true`; `cancelSent()` cannot
  preempt CPU-bound work in the single-threaded worker (measured), so the engine
  may still finish the query.

### `@weisql/usearch-adapter` 0.1.0

- HNSW `VectorAdapter` with measured metric mapping and honest `exact: false`.
- Persisted index loading (`index.params`) and in-memory build fallback.
- Optional post-filtering mode (`filtering: "post-filter"`) that honours row
  filters by widening the candidate window and marks results incomplete.
- Persisted index loading rejects a different USearch major version instead of
  risking a silently misread index.

### Tooling (not published)

- Deterministic fuzz tests for the Manifest and container parsers: every input
  must either succeed or throw a `WeiSQLError` with a documented code.
- Apache-2.0 license, with a copy in the repository root and inside every
  published package.

- GitHub Actions CI: build, typecheck, tests and release checks on Ubuntu and
  Windows, plus fixture reproducibility, derived indexes and container packing.
  The `derived` job also runs `bench:wasm --smoke` to catch broken
  adapter/extension wiring, and `npm run test:contract` to hold both SQL
  adapters to one declared contract; the `verify` matrix runs the same contract
  on both operating systems. A `browser` job runs `probe:browser`,
  `probe:wasm`, `probe:playground` and `probe:parity` on the runner's Chrome.
- `@weisql/sdk` exports `./errors` so browser adapters can import `WeiSQLError`
  without pulling the Node-only resource readers into a bundle.
- `npm run probe:wasm` runs the DuckDB-Wasm probe in Chromium; `npm run
  vendor:wasm-extension` caches the parquet extension matching the WASM core;
  `npm run bench:wasm` measures materialization and filtered queries at 50k–500k
  rows (Node WASM; time and RSS, not a performance promise);
  `npm run bench:wasm-stream` measures browser `sqlStream()` first-row latency,
  throughput and heap growth on synthetic rows, then on 200k- and 500k-row
  Parquet packages (HTTP Range + L3 + materialize) against `db.sql()`;
  `npm run bench:wasm-cold` measures the cache-disabled first load (36.3 MB).
- Browser probes now also cover read-only CTEs and browser-side filtered vector
  search (`exact-filter-first`); the playground gained SQL and category filters,
  plus a streaming toggle that renders rows as they arrive from `db.sqlStream()`
  and a row-budget field that surfaces `maxRows` rejections.
- Browser probe, playground example, cross-environment parity check.
- Playground now demonstrates full-text search and RAG evidence against a package
  it builds at start-up, and can switch between directory, `.wsql` and streaming
  `.wsql` loading; the probe asserts all three.
- Parity probe extended to full-text, RAG evidence, SQL (rows and error codes),
  streaming `sqlStream()` rows, stream error codes and pre-aborted streams, and
  the `.wsql` container, against a package it builds at run time.
- Benchmark harness with exact and ANN (`--ann`) modes.
- Clustered vector distributions (`--clusters/--cluster-spread`) showing that ANN
  recall depends on data geometry, not only on `expansion_search`.
- Full-text benchmark mode (`--text`): synthetic Zipf corpus, index build time,
  index size breakdown and BM25 query latency.
- RAG evidence is cut at a sentence boundary, then a word boundary, then a hard
  cut; each evidence reports where the cut happened via `boundary`.
- Fusion stability study (`--fusion`): measures how RRF `k` changes the ranking,
  and states that this is not a relevance-quality measurement.
- Filtered benchmark mode (`--filter`): reports vector bytes, ID Map bytes and
  latency for a narrow and a broad filter.
- `release:pack` inspects the actual `npm pack` file list for every workspace and
  fails on leaked source/test files, missing LICENSE/README, or dead exports.
- `bench:quantization` measures f32/f16/i8 index size against Recall@K on the same
  synthetic vectors; quantization is deliberately not part of the package format.
- `bench:recall` measures ANN Recall@K on real embeddings from a `.npy` or raw
  `.f32` file, keeping exact search as ground truth.
- `bench:self-test` runs harness self-checks in CI (quantization size ordering,
  `.npy` parsing and recall computation).
- ANN index builder and release checks.
- Text index builder (`tools/build-text-index.mjs`) reading the Parquet column and
  updating the Manifest.
- CSV/JSON to Parquet conversion (`tools/source-to-parquet.mjs`) with conservative
  type inference and Manifest-ready column output.
