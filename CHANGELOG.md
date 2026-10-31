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
- Manifest signing: Ed25519 over canonical JSON, `signManifest()` /
  `verifyManifestSignature()` with optional pinned key ids.
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

### `@weisql/duckdb-adapter` 0.1.0

- Read-only DuckDB adapter: statement-type enforcement, parameter binding,
  L4 schema verification, native interruption.
- `tableLoading: "memory" | "lazy"` with the security/memory trade-off documented.

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
- Browser probe, playground example, cross-environment parity check.
- Playground now demonstrates full-text search and RAG evidence against a package
  it builds at start-up, and can switch between directory, `.wsql` and streaming
  `.wsql` loading; the probe asserts all three.
- Parity probe extended to full-text, RAG evidence and the `.wsql` container,
  against a package it builds at run time.
- Benchmark harness with exact and ANN (`--ann`) modes.
- Clustered vector distributions (`--clusters/--cluster-spread`) showing that ANN
  recall depends on data geometry, not only on `expansion_search`.
- Full-text benchmark mode (`--text`): synthetic Zipf corpus, index build time,
  index size breakdown and BM25 query latency.
- Fusion stability study (`--fusion`): measures how RRF `k` changes the ranking,
  and states that this is not a relevance-quality measurement.
- ANN index builder and release checks.
- Text index builder (`tools/build-text-index.mjs`) reading the Parquet column and
  updating the Manifest.
- CSV/JSON to Parquet conversion (`tools/source-to-parquet.mjs`) with conservative
  type inference and Manifest-ready column output.
