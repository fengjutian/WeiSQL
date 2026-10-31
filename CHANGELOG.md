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
- RAG retrieval: `db.rag.search()` assembling budgeted evidence with provenance;
  the SDK never calls a model.
- `.wsql` single-file container: `createContainer()`, `parseContainer()` and
  `ContainerReader` (a standard `ResourceReader`).

### `@weisql/cli` 0.1.0

- `weisql validate <dir|file.wsql>` with `--mode` / `--json` and exit codes 0/1/2.
- `weisql pack <dir> --output <file>` produces a `.wsql` container; validating a
  container checks both the container digests and the Manifest resources.

### `@weisql/duckdb-adapter` 0.1.0

- Read-only DuckDB adapter: statement-type enforcement, parameter binding,
  L4 schema verification, native interruption.
- `tableLoading: "memory" | "lazy"` with the security/memory trade-off documented.

### `@weisql/usearch-adapter` 0.1.0

- HNSW `VectorAdapter` with measured metric mapping and honest `exact: false`.
- Persisted index loading (`index.params`) and in-memory build fallback.
- Optional post-filtering mode (`filtering: "post-filter"`) that honours row
  filters by widening the candidate window and marks results incomplete.

### Tooling (not published)

- Apache-2.0 license, with a copy in the repository root and inside every
  published package.

- GitHub Actions CI: build, typecheck, tests and release checks on Ubuntu and
  Windows, plus fixture reproducibility, derived indexes and container packing.
- Browser probe, playground example, cross-environment parity check.
- Parity probe extended to full-text, RAG evidence and the `.wsql` container,
  against a package it builds at run time.
- Benchmark harness with exact and ANN (`--ann`) modes.
- Clustered vector distributions (`--clusters/--cluster-spread`) showing that ANN
  recall depends on data geometry, not only on `expansion_search`.
- Full-text benchmark mode (`--text`): synthetic Zipf corpus, index build time,
  index size breakdown and BM25 query latency.
- ANN index builder and release checks.
- Text index builder (`tools/build-text-index.mjs`) reading the Parquet column and
  updating the Manifest.
