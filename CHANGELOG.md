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
- `OpenOptions.maxResourceBytes` / `maxTotalBytes`: raise the L3 per-resource
  (default 64 MiB) and total budgets so a single large Parquet file can be
  verified; the hashing algorithm is unchanged.
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
- The tested WASM vector modules ship inside the package under `wasm/`:
  `wasmArtifactUrl("exact" | "hnsw")` resolves `weisql_vector_wasm.wasm` and
  `weisql_vector_hnsw_wasm.wasm`; `wasm/artifacts.json` records size, SHA-256,
  ABI version and required exports. `npm run embed:wasm` refreshes them and
  `release:check` rejects a package whose bytes disagree with the manifest.

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
- Opt-in OPFS persistence (`persistToOpfs`): the cache key comes from the Manifest
  table bytes and SHA-256, a hit skips materialization but still runs L4, and
  `flushFiles()` runs before `terminate()`. OPFS/WebCrypto/flush failures fall
  back to memory (ADR-070, ADR-071). Old entries are pruned to the current
  database plus the three newest, WAL files included. A Web Locks exclusive lock
  covers each database; a second tab gets memory instead of sharing writes.
- `npm run probe:opfs-lock` opens two pages in one browser context and asserts
  the second falls back to memory, then a third page reclaims the cache.
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
- A persisted index without `connectivity` / `expansion_add` /
  `expansion_search` is rejected with `RESOURCE_INTEGRITY_FAILED` instead of
  falling back to adapter defaults (ADR-029).

### Tooling (not published)

- `tools/build-ann-index.mjs` builds either backend with one command:
  `--engine usearch` writes a USearch index, `--engine hnsw` runs the HNSW WASM
  module; both record `index.params` and a real digest in the Manifest.
  `--recall-samples/--recall-top-k/--min-recall` sample deterministic rows and
  gate the build on Recall@K against an exact scan.
- `tools/embed-wasm.mjs` embeds both WASM artifacts into `@weisql/sdk/wasm` and
  writes `artifacts.json`; `--check` is used by `release:check` and `prepack`.
- `npm run probe:wasm-vector` (`tools/browser-probe/wasm-vector.html`): a
  Chromium probe that fetches the packaged artifacts through `wasmArtifactUrl()`
  and compares the TypeScript exact adapter, the exact WASM artifact and the
  HNSW artifact on the example package — same rows/IDs, distances within `1e-9`,
  expected `diagnostics.backend`, no Node globals. Wired into the CI browser job.
- `tools/cdn-probe.mjs` (`npm run probe:cdn`) checks CORS, `206`,
  `Content-Range`, `Content-Length`, `Accept-Ranges` and exposed headers on a
  deployed package; `docs/CDN_ACCEPTANCE.md` records the checklist.
- `bench:recall` accepts `--output <report.json>` and `--min-recall <n>` so a
  real-embedding run produces a reproducible acceptance record.
- Deterministic fuzz tests for the Manifest and container parsers: every input
  must either succeed or throw a `WeiSQLError` with a documented code.
- Apache-2.0 license, with a copy in the repository root and inside every
  published package.

- `npm run release:e2e` packs the SDK and DuckDB adapter, installs the tarballs in a temp project and runs SQL, vector search and a stream against the fixture (catches broken `exports` or missing runtime deps).
- OPFS database persistence re-verified on DuckDB-Wasm 1.32.0: it works when `flushFiles()` runs before terminating; the adapter cache is still unimplemented (ADR-070).
- GitHub Actions CI: build, typecheck, tests and release checks on Ubuntu and
  Windows, plus fixture reproducibility, derived indexes and container packing.
  The `derived` job also runs `bench:wasm --smoke` to catch broken
  adapter/extension wiring, and `npm run test:contract` to hold both SQL
  adapters to one declared contract; the `verify` matrix runs the same contract
  on both operating systems. A `browser` job runs `probe:browser`,
  `probe:wasm`, `probe:opfs-lock`, `probe:playground` and `probe:parity` on the
  runner's Chrome.
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
  The same command's materialize segment charts 200k/500k/1M-row Parquet:
  ~60 MB engine memory per million rows, linear heap growth.
- Browser probes now also cover read-only CTEs and browser-side filtered vector
  search (`exact-filter-first`); the playground gained SQL and category filters,
  plus a streaming toggle that renders rows as they arrive from `db.sqlStream()`
  and a row-budget field that surfaces `maxRows` rejections; a failed query
  clears the rendered table instead of leaving a partial result.
- Browser probe, playground example, cross-environment parity check.
- Playground now demonstrates full-text search and RAG evidence against a package
  it builds at start-up, and can switch between directory, `.wsql` and streaming
  `.wsql` loading; the probe asserts all three.
- Parity probe extended to full-text, RAG evidence, SQL (rows and error codes),
  streaming `sqlStream()` rows, stream error codes and pre-aborted streams, and
  the `.wsql` container, against a package it builds at run time.
- The shared SQL contract also checks that abandoning a stream with `break`
  leaves the adapter usable for the next query.
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
- Cross-language golden fixture: `tools/bench/rust-golden.mjs` renders six fixed
  datasets through `exactVectorSearch`, and
  `crates/vector-benchmark/tests/golden_tests.rs` asserts the Rust baseline
  returns the same ranking and distances (1e-6 tolerance). CI regenerates the
  TypeScript side and runs the Rust side, so drift fails whichever language
  changed.
- Rust baseline hardened: one validation/scan pass, `f64` accumulation, a
  fixed-capacity max heap instead of a full sort, `top_k`/zero-dimension
  contracts aligned with TypeScript, and a `rust vector baseline` CI job
  (`fmt`/`clippy`/`test`/release smoke).
- `crates/vector-wasm`: the baseline compiled to `wasm32-unknown-unknown` behind
  a flat C ABI (`weisql_alloc` / `weisql_search_topk` / `weisql_dealloc`, ABI v3)
  with no imports and no wasm-bindgen, about 17 KB stripped. `metric` selects
  cosine, L2 or inner product, matching the TypeScript search contract, and the
  v1 `weisql_cosine_topk` entry point remains as an alias. Two golden fixtures
  (9 cases) now gate TypeScript, native Rust and the WASM artifact, and the core
  gained `exact_search` / `exact_search_contiguous` over a `Metric` enum with a
  zero-copy row-major layout.
- Distances are returned in `f64` (WASM `out_distances` is `f64`, ABI v3). The
  new property tests caught that an inner product of large `f32` vectors
  overflowed `f32::MAX` and surfaced `-inf`, which would both break the
  "finite distance" contract and diverge from TypeScript's doubles; the scan
  already accumulated in `f64`, so only the stored/exported type changed.
- `tests/property_tests.rs`: deterministic property tests across shapes and
  metrics — brute-force agreement, `top_k` being a prefix of the full ordering,
  cosine scale invariance, L2/IP scaling laws, finite extreme magnitudes and
  contiguous-layout equality.
- `crates/vector-hnsw`: a dependency-free HNSW fallback engine (layered graph,
  diversity-heuristic neighbour selection, SplitMix64 levels so a seed
  reproduces the graph). Ten tests cover structural bounds, determinism, query
  validation and Recall@10 against the exact baseline for all three metrics;
  `examples/recall.rs` reports 2000×32 clustered data at Recall@10 = 1.00 with a
  p50 of 0.048 ms. USearch remains the default ANN engine.
- `crates/vector-hnsw-wasm`: the same graph behind a 41 KB, import-free C ABI —
  build once per module instance, then search with `f64` distances. A Node probe
  builds 1000×16 clustered data inside the module and checks Recall@10 against a
  JavaScript brute-force scan (1.00, p50 0.033 ms).
- `createHnswWasmVectorAdapter()`: a `VectorAdapter` over the HNSW module. It
  builds the graph lazily per data path **and metric** (a metric switch
  rebuilds), reports `exactSearch: false`, and post-filters by over-fetching
  `topK × oversample` for `allowedRows`, marking results `postFiltered`. A probe
  compares 20 queries against the exact adapter (Recall@10 ≥ 0.9, distances
  equal to `vectorDistance`, filtered rows inside `allowedRows`).
- The WASM adapters now share `wasm-vector-support.ts` for materialisation,
  business-ID resolution and cancellation instead of duplicating it.
- HNSW persistence: `HnswIndex::to_bytes()` / `from_bytes()` with a versioned,
  checksummed format. Loading validates the header, layer counts, neighbour
  capacities, id ranges, vector finiteness and the trailing FNV-1a checksum, so
  a truncated or tampered buffer fails instead of becoming a broken graph; six
  tests cover round trips and corruption cases.
- HNSW WASM ABI v2 exposes `weisql_hnsw_serialized_len` / `weisql_hnsw_save` /
  `weisql_hnsw_load`. The WASM probe now builds a graph, exports it, imports it
  into a second freshly instantiated module and asserts the same query returns
  bit-identical ids and distances (122 KB for 1000×16).
- HNSW WASM ABI v3 adds `weisql_hnsw_metric()`, and
  `createHnswWasmVectorAdapter()` accepts `loadIndex`: a serialized graph is
  imported instead of built, then checked against the descriptor's row count,
  dimension and metric. A corrupt buffer or a graph for another metric raises
  `RESOURCE_INTEGRITY_FAILED` rather than silently rebuilding.
- The HNSW adapter now consumes Manifest-declared indexes
  (`vector.index.engine === "weisql-hnsw"`, format major `1`). It validates the
  engine, format major and declared byte length, and when an index is declared
  it never reads the vector file at all — the probe uses a reader that throws on
  any vector read to prove it. `capabilities.persistedIndex` is now `true`.
- `tools/build-hnsw-index.mjs` closes the loop: it builds the graph inside the
  WASM module, writes `indexes/<collection>.hnsw`, and records
  `engine`/`version`/`file` (bytes + SHA-256)/`params` in the Manifest after a
  final `validateManifest`. A package probe copies the example package, runs the
  tool, checks the digest, and searches through the Manifest-declared index.
- The unified ANN builder (`tools/build-ann-index.mjs --engine hnsw`) can report
  Recall@K after building: `--recall-samples`, `--recall-top-k` and
  `--min-recall`. Samples are deterministic rows, the reference is an exact scan
  with the collection's metric, and the result is printed as `recall` (not
  persisted); `--min-recall` fails the command when the graph misses the target.
- `tools/bench/hnsw-dataset.mjs` (`npm run bench:hnsw-dataset`) measures the WASM
  HNSW engine at scale against a JavaScript exact scan: build time, index bytes,
  p50/p95 for both engines and Recall@K. It accepts raw little-endian `.f32`
  embeddings via `--file`, so the same command works on real data, and
  `--distribution random` generates the harder uniform direction case. Baseline:
  10k×32 clustered builds in 2.1 s with Recall@10 = 1.00; 10k×256 random takes
  61.8 s and lands at Recall@10 = 0.95 (1.05 ms vs 9.49 ms exact); 50k×64
  clustered builds in 42 s at Recall@10 = 0.997. `docs/HNSW_EVALUATION.md` is the
  runbook for real embeddings: data layout, commands, what each field means, a
  results template, and the limits that make synthetic numbers non-transferable.
- `createWasmVectorAdapter()`: a `VectorAdapter` over that artifact. It caches
  one materialised `Float32Array` per collection, compacts `allowedRows` before
  the scan so filtered results stay exact, and maps rows back to business IDs
  through the indexed ID map. A Node probe compares it with
  `createExactVectorAdapter` on the same in-memory collection for all three
  metrics, filtered and unfiltered, plus the zero-query error code.
- ANN index builder and release checks.
- Text index builder (`tools/build-text-index.mjs`) reading the Parquet column and
  updating the Manifest.
- CSV/JSON to Parquet conversion (`tools/source-to-parquet.mjs`) with conservative
  type inference and Manifest-ready column output; nested JSON objects/arrays
  become `json` columns, while mixing them with scalars stays an error.
  `--timestamp col[,col]` turns strict ISO 8601 strings into `timestamp` columns
  (offsets normalized to UTC); date-only strings are rejected.
