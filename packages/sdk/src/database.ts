import { WeiSQLError } from "./errors.js";
import { CachedResourceReader } from "./cached-resource-reader.js";
import { exactVectorSearch } from "./exact-vector-search.js";
import { verifyManifestResources } from "./integrity.js";
import { IndexedIdMapReader } from "./indexed-id-map-reader.js";
import { validateManifest } from "./manifest.js";
import type { ResourceReader } from "./resource-reader.js";
import type { SqlAdapter } from "./sql-adapter.js";
import type { HybridFusionHit, HybridSearchOptions, HybridStrategy, OpenOptions, QueryOptions, RagResult, RagSearchOptions, RuntimeState, SQLValue, VectorCollectionDescriptor, VectorHit, VectorSearchOptions, WeiSQLCapabilities, WeiSQLManifest } from "./types.js";
import type { TextHit, TextSearchOptions } from "./text-index-reader.js";
import { TextIndexReader } from "./text-index-reader.js";
import { reciprocalRankFusion } from "./fusion.js";
import { truncateToBudget } from "./text-truncate.js";
import { businessIdKey } from "./vector-filter.js";
import type { VectorAdapter } from "./vector-adapter.js";
import { VectorBlockReader } from "./vector-block-reader.js";
import { candidateCapFor, exactFilterFirst, vectorFirst } from "./hybrid-executor.js";
import { SortedIdIndexReader, shouldUseIdIndex } from "./sorted-id-index.js";

export interface WeiSQLDatabase {
  readonly manifest: Readonly<WeiSQLManifest>;
  readonly state: RuntimeState;
  sql<T extends Record<string, unknown> = Record<string, unknown>>(query: string, params?: readonly SQLValue[], options?: QueryOptions): Promise<readonly T[]>;
  readonly vector: { search(vectorName: string, queryVector: Float32Array | readonly number[], options?: VectorSearchOptions): Promise<readonly VectorHit[]> };
  readonly text: { search(indexName: string, query: string, options?: TextSearchOptions): Promise<readonly TextHit[]> };
  readonly hybrid: { search(options: HybridSearchOptions): Promise<readonly HybridFusionHit[]> };
  readonly rag: { search(options: RagSearchOptions): Promise<RagResult> };
  capabilities(): Readonly<WeiSQLCapabilities>;
  close(): Promise<void>;
}

class Database implements WeiSQLDatabase {
  private runtimeState: RuntimeState = "OPENING";
  private closePromise: Promise<void> | undefined;
  readonly manifest: Readonly<WeiSQLManifest>;
  readonly vector;
  readonly text;
  readonly hybrid;
  readonly rag;
  private readonly textReaders = new Map<string, TextIndexReader>();
  private readonly idIndexes = new Map<string, SortedIdIndexReader>();
  private constructor(
    manifest: WeiSQLManifest,
    private readonly reader?: ResourceReader,
    private readonly sqlAdapter?: SqlAdapter,
    private readonly vectorAdapter?: VectorAdapter,
  ) {
    this.manifest = manifest;
    this.vector = { search: this.search.bind(this) };
    this.text = { search: this.textSearch.bind(this) };
    this.hybrid = { search: this.hybridSearch.bind(this) };
    this.rag = { search: this.ragSearch.bind(this) };
  }
  static async create(
    manifest: WeiSQLManifest,
    reader: ResourceReader | undefined,
    sqlAdapter: SqlAdapter | undefined,
    vectorAdapter: VectorAdapter | undefined,
    signal?: AbortSignal,
  ): Promise<Database> {
    if (sqlAdapter && !reader) throw new WeiSQLError("INVALID_ARGUMENT", "A SQL adapter requires a resourceReader");
    if (vectorAdapter && !reader) throw new WeiSQLError("INVALID_ARGUMENT", "A vector adapter requires a resourceReader");
    const database = new Database(manifest, reader, sqlAdapter, vectorAdapter);
    try {
      if (sqlAdapter && reader) await sqlAdapter.open({ manifest, reader, ...(signal ? { signal } : {}) });
      if (vectorAdapter && reader) await vectorAdapter.open({ manifest, reader, ...(signal ? { signal } : {}) });
      aborted(signal);
      database.runtimeState = "READY";
      return database;
    } catch (cause) {
      database.runtimeState = "FAILED";
      await database.releaseResources();
      throw cause;
    }
  }
  get state(): RuntimeState { return this.runtimeState; }
  async sql<T extends Record<string, unknown>>(query: string, params: readonly SQLValue[] = [], options?: QueryOptions): Promise<readonly T[]> {
    this.ensureOpen(); aborted(options?.signal);
    if (!this.sqlAdapter) throw new WeiSQLError("SQL_UNSUPPORTED", "No SQL adapter is configured");
    return this.sqlAdapter.query<T>(query, params, options);
  }

  /**
   * Reciprocal-rank fusion of vector and text results.
   *
   * RRF is used instead of score normalisation because BM25 scores are unbounded
   * and vector distances live in metric-specific ranges; only ranks are
   * comparable across sources. Each source is over-fetched so the fusion has
   * candidates that are not in the other list.
   */
  private async hybridSearch(options: HybridSearchOptions): Promise<readonly HybridFusionHit[]> {
    this.ensureOpen(); aborted(options?.signal);
    if (options.vector === undefined && options.text === undefined) {
      throw new WeiSQLError("INVALID_ARGUMENT", "hybrid.search requires at least one source", { sources: [] });
    }
    const topK = options.topK ?? 10;
    if (!Number.isSafeInteger(topK) || topK <= 0) throw new WeiSQLError("INVALID_ARGUMENT", "topK must be a positive integer", { topK });
    const k = options.k ?? 60;
    if (!(k > 0) || !Number.isFinite(k)) throw new WeiSQLError("INVALID_ARGUMENT", "k must be a positive finite number", { k });
    const started = typeof performance === "undefined" ? 0 : performance.now();
    const sourceTopK = Math.max(topK * 4, topK);
    const signalOption = options.signal === undefined ? {} : { signal: options.signal };

    const vectorHits = options.vector === undefined
      ? []
      : await this.search(options.vector.name, options.vector.query, { topK: options.vector.topK ?? sourceTopK, ...signalOption });
    const textHits = options.text === undefined
      ? []
      : await this.textSearch(options.text.name, options.text.query, { topK: options.text.topK ?? sourceTopK, ...signalOption });

    const rankings = [];
    if (vectorHits.length > 0) rankings.push({ name: "vector", ids: vectorHits.map(hit => hit.id) });
    if (textHits.length > 0) rankings.push({ name: "text", ids: textHits.map(hit => hit.id) });
    if (rankings.length === 0) return [];

    const fused = reciprocalRankFusion(rankings, { k, topK });
    const vectorById = new Map(vectorHits.map(hit => [businessIdKey(hit.id), hit]));
    const textById = new Map(textHits.map(hit => [businessIdKey(hit.id), hit]));
    const elapsedMs = typeof performance === "undefined" ? undefined : performance.now() - started;

    return fused.map(entry => {
      const vector = vectorById.get(businessIdKey(entry.id));
      const text = textById.get(businessIdKey(entry.id));
      return {
        id: entry.id,
        score: entry.score,
        ranks: entry.ranks,
        ...(vector === undefined ? {} : { vector: { row: vector.row, distance: vector.distance } }),
        ...(text === undefined ? {} : { text: { row: text.row, score: text.score } }),
        diagnostics: { backend: "rrf" as const, k, ...(elapsedMs === undefined ? {} : { elapsedMs }) },
      };
    });
  }

  /**
   * Assembles retrieval evidence for RAG.
   *
   * WeiSQL does not call a model and does not render prompts: it returns the
   * fused, budgeted evidence plus its provenance, so the caller keeps control of
   * prompting, citations and model choice.
   */
  private async ragSearch(options: RagSearchOptions): Promise<RagResult> {
    this.ensureOpen(); aborted(options?.signal);
    if (options.text === undefined) {
      throw new WeiSQLError("INVALID_ARGUMENT", "rag.search requires a text source, which carries the document text");
    }
    const topK = options.topK ?? 5;
    if (!Number.isSafeInteger(topK) || topK <= 0) throw new WeiSQLError("INVALID_ARGUMENT", "topK must be a positive integer", { topK });
    const maxCharacters = options.maxCharacters ?? 4000;
    if (!Number.isSafeInteger(maxCharacters) || maxCharacters <= 0) {
      throw new WeiSQLError("INVALID_ARGUMENT", "maxCharacters must be a positive integer", { maxCharacters });
    }
    const k = options.k ?? 60;
    if (!(k > 0) || !Number.isFinite(k)) throw new WeiSQLError("INVALID_ARGUMENT", "k must be a positive finite number", { k });

    const descriptor = (this.manifest.textIndexes ?? []).find(item => item.name === options.text!.name);
    if (descriptor === undefined) throw new WeiSQLError("INDEX_NOT_FOUND", `Unknown text index '${options.text.name}'`, { index: options.text.name });
    if (descriptor.documents === undefined) {
      throw new WeiSQLError("INVALID_ARGUMENT", "This text index does not declare documents; rebuild it with the current builder", { index: descriptor.name });
    }

    const started = typeof performance === "undefined" ? 0 : performance.now();
    const signalOption = options.signal === undefined ? {} : { signal: options.signal };
    const fused = await this.hybridSearch({
      topK,
      k,
      text: options.text,
      ...(options.vector === undefined ? {} : { vector: options.vector }),
      ...signalOption,
    });

    const rows = fused.map(hit => hit.text?.row).filter((row): row is number => row !== undefined);
    const textReader = this.textReaders.get(descriptor.name);
    if (textReader === undefined) throw new WeiSQLError("INTERNAL_ERROR", "Text reader missing for the declared index");
    const documents = await textReader.getDocuments(rows, signalOption);

    const evidences: RagResult["evidences"][number][] = [];
    let usedCharacters = 0;
    let truncated = false;
    let droppedHits = 0;
    for (const [index, hit] of fused.entries()) {
      const row = hit.text?.row;
      const text = row === undefined ? undefined : documents.get(row);
      if (text === undefined || usedCharacters >= maxCharacters) {
        droppedHits++;
        continue;
      }
      const remaining = maxCharacters - usedCharacters;
      const fragment = truncateToBudget(text, remaining);
      if (fragment.truncated) truncated = true;
      usedCharacters += fragment.text.length;
      evidences.push({
        id: hit.id,
        text: fragment.text,
        rank: index + 1,
        characters: fragment.text.length,
        truncated: fragment.truncated,
        boundary: fragment.boundary,
        ranks: hit.ranks,
      });
    }

    const elapsedMs = typeof performance === "undefined" ? undefined : performance.now() - started;
    return {
      evidences,
      usedCharacters,
      truncated,
      droppedHits,
      diagnostics: { backend: "rrf", k, maxCharacters, ...(elapsedMs === undefined ? {} : { elapsedMs }) },
    };
  }

  /** BM25 text search over a Manifest-declared `textIndexes` entry. */
  private async textSearch(indexName: string, query: string, options?: TextSearchOptions): Promise<readonly TextHit[]> {
    this.ensureOpen(); aborted(options?.signal);
    if (typeof query !== "string") throw new WeiSQLError("INVALID_ARGUMENT", "Text query must be a string");
    const descriptor = (this.manifest.textIndexes ?? []).find(item => item.name === indexName);
    if (descriptor === undefined) throw new WeiSQLError("INDEX_NOT_FOUND", `Unknown text index '${indexName}'`, { index: indexName });
    if (!this.reader) throw new WeiSQLError("INDEX_NOT_FOUND", "No resource reader is configured");
    let index = this.textReaders.get(indexName);
    if (index === undefined) {
      index = new TextIndexReader(this.reader, descriptor);
      this.textReaders.set(indexName, index);
    }
    return index.search(query, {
      topK: options?.topK ?? 10,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }
  private async search(vectorName: string, queryVector: Float32Array | readonly number[], options?: VectorSearchOptions): Promise<readonly VectorHit[]> {
    this.ensureOpen(); aborted(options?.signal);
    const topK = options?.topK ?? 10;
    if (!Number.isSafeInteger(topK) || topK <= 0) throw new WeiSQLError("VECTOR_INVALID_VALUE", "topK must be a positive integer", { topK });
    const vector = this.manifest.vectorCollections.find(item => item.name === vectorName);
    if (!vector) throw new WeiSQLError("INDEX_NOT_FOUND", `Unknown vector '${vectorName}'`);
    if (queryVector.length !== vector.dimension) throw new WeiSQLError("VECTOR_DIMENSION_MISMATCH", "Query vector dimension does not match manifest", { expected: vector.dimension, actual: queryVector.length });
    for (let i = 0; i < queryVector.length; i++) if (!Number.isFinite(queryVector[i])) throw new WeiSQLError("VECTOR_INVALID_VALUE", "Query vector contains a non-finite value", { position: i });
    if (vector.metric === "cosine" && !queryVector.some(value => value !== 0)) throw new WeiSQLError("VECTOR_INVALID_VALUE", "Cosine distance is undefined for a zero query vector");
    const filter = options?.filter;
    const strategy = options?.strategy ?? "exact-filter-first";
    if (options?.strategy !== undefined && filter === undefined) {
      throw new WeiSQLError("INVALID_ARGUMENT", "A hybrid strategy requires a filter", { strategy });
    }
    if (filter !== undefined && !this.sqlAdapter) throw new WeiSQLError("SQL_UNSUPPORTED", "Vector filtering requires a SQL or metadata-filtering adapter", { strategy });
    if (!this.reader) throw new WeiSQLError("INDEX_NOT_FOUND", "No vector resource reader is configured");
    if (this.vectorAdapter !== undefined) return this.searchWithAdapter(vector, queryVector, topK, filter, strategy, options);
    const started = performance.now();
    const idMap = new IndexedIdMapReader(this.reader, {
      dataPath: vector.idMap.data.path,
      offsetsPath: vector.idMap.offsets.path,
      count: vector.idMap.count,
      dataBytes: vector.idMap.data.bytes,
      offsetsBytes: vector.idMap.offsets.bytes,
    });
    const reader = new VectorBlockReader(this.reader, { path: vector.data.path, count: vector.count, dimension: vector.dimension, bytes: vector.data.bytes });
    const query = queryVector instanceof Float32Array ? queryVector : Float32Array.from(queryVector);
    const signalOption = options?.signal === undefined ? {} : { signal: options.signal };
    try {
      if (filter !== undefined && strategy === "vector-first") {
        return await this.vectorFirstSearch({ vector, reader, idMap, query, topK, filter, options, started });
      }
      const allowed = filter === undefined ? undefined : (await exactFilterFirst({
        manifest: this.manifest,
        sqlAdapter: this.sqlAdapter!,
        idMap,
        ...(this.reader === undefined ? {} : { reader: this.reader }),
        ...(this.idIndexOf(vector) === undefined ? {} : { idIndex: this.idIndexOf(vector)! }),
        vector,
        filter,
        ...signalOption,
      })).allowedRows;
      if (allowed !== undefined && allowed.size === 0) return [];
      const hits = await exactVectorSearch({
        reader,
        idMap,
        query,
        collectionCount: vector.count,
        dimension: vector.dimension,
        search: {
          topK,
          metric: vector.metric,
          ...signalOption,
          ...(allowed === undefined ? {} : { isAllowed: (row: number) => allowed.has(row), allowedRows: allowed }),
        },
      });
      const elapsedMs = performance.now() - started;
      if (allowed === undefined) {
        return hits.map(hit => ({ ...hit, diagnostics: { backend: "typescript-exact", exact: true, elapsedMs } }));
      }
      return hits.map(hit => ({
        ...hit,
        diagnostics: { backend: "typescript-exact+sql-filter", exact: true, strategy: "exact-filter-first" as const, filteredCandidates: allowed.size, elapsedMs },
      }));
    } finally {
      await idMap.close();
    }
  }

  /**
   * `vector-first`: scan a bounded candidate window exactly, then keep the hits
   * the SQL filter accepts. Results are not guaranteed to be the filtered top-K
   * unless the window reached the whole collection, which the diagnostics state.
   */
  private async vectorFirstSearch(input: {
    vector: WeiSQLManifest["vectorCollections"][number];
    reader: VectorBlockReader;
    idMap: IndexedIdMapReader;
    query: Float32Array;
    topK: number;
    filter: NonNullable<VectorSearchOptions["filter"]>;
    options: VectorSearchOptions | undefined;
    started: number;
  }): Promise<readonly VectorHit[]> {
    const { vector, reader, idMap, query, topK, filter, options, started } = input;
    const candidateCap = candidateCapFor(options?.vectorFirst?.maxCandidates, topK, vector.count);
    const candidates = await exactVectorSearch({
      reader,
      idMap,
      query,
      collectionCount: vector.count,
      dimension: vector.dimension,
      search: { topK: candidateCap, metric: vector.metric, ...(options?.signal === undefined ? {} : { signal: options.signal }) },
    });
    const plan = await vectorFirst({
      manifest: this.manifest,
      sqlAdapter: this.sqlAdapter!,
      vector,
      filter,
      candidates: candidates.map(hit => ({ id: hit.id })),
      topK,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      ...(options?.vectorFirst === undefined ? {} : options.vectorFirst),
    });
    const elapsedMs = performance.now() - started;
    return plan.matchedIndexes.map(index => {
      const hit = candidates[index]!;
      return {
        ...hit,
        diagnostics: {
          backend: "typescript-exact+sql-filter",
          exact: plan.exact,
          strategy: "vector-first" as const,
          candidatesScanned: plan.candidatesScanned,
          filteredCandidates: plan.filteredCandidates,
          candidateCap: plan.candidateCap,
          elapsedMs,
        },
      };
    });
  }

  /**
   * Delegates to an injected `VectorAdapter`.
   *
   * The Runtime keeps validation and the filter→row-set resolution, so an ANN
   * adapter never needs SQL access and can never silently widen a filter. Filters
   * require `exactSearch: true`, or `postFiltering: true` for an adapter that
   * explicitly accepts incomplete filtered results.
   */
  private async searchWithAdapter(
    vector: WeiSQLManifest["vectorCollections"][number],
    queryVector: Float32Array | readonly number[],
    topK: number,
    filter: VectorSearchOptions["filter"],
    strategy: HybridStrategy,
    options: VectorSearchOptions | undefined,
  ): Promise<readonly VectorHit[]> {
    const adapter = this.vectorAdapter!;
    if (filter !== undefined) {
      if (!adapter.capabilities.exactSearch && !adapter.capabilities.postFiltering) {
        throw new WeiSQLError("SQL_UNSUPPORTED", "Filtering requires an exact vector adapter or an adapter with post-filtering", { engine: adapter.capabilities.engine });
      }
      if (strategy === "vector-first") {
        throw new WeiSQLError("SQL_UNSUPPORTED", "vector-first is only available on the built-in exact pipeline", { engine: adapter.capabilities.engine });
      }
    }
    const query = queryVector instanceof Float32Array ? queryVector : Float32Array.from(queryVector);
    const allowedRows = filter === undefined ? undefined : await this.resolveAllowedRows(vector, filter, options?.signal);
    const hits = await adapter.search({
      vector,
      query,
      topK,
      ...(allowedRows === undefined ? {} : { allowedRows }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
    if (allowedRows !== undefined && hits.some(hit => !allowedRows.has(hit.row))) {
      // An adapter that returns rows outside the filter has broken the contract;
      // returning them would silently widen the result set.
      throw new WeiSQLError("INTERNAL_ERROR", "Vector adapter returned rows outside the requested filter", { engine: adapter.capabilities.engine });
    }
    return hits;
  }

  /** Resolves the V1 equality filter into a row set for adapters to honour. */
  private async resolveAllowedRows(
    vector: WeiSQLManifest["vectorCollections"][number],
    filter: NonNullable<VectorSearchOptions["filter"]>,
    signal: AbortSignal | undefined,
  ): Promise<ReadonlySet<number>> {
    const idMap = new IndexedIdMapReader(this.reader!, {
      dataPath: vector.idMap.data.path,
      offsetsPath: vector.idMap.offsets.path,
      count: vector.idMap.count,
      dataBytes: vector.idMap.data.bytes,
      offsetsBytes: vector.idMap.offsets.bytes,
    });
    try {
      const result = await exactFilterFirst({
        manifest: this.manifest,
        sqlAdapter: this.sqlAdapter!,
        idMap,
        ...(this.reader === undefined ? {} : { reader: this.reader }),
        ...(this.idIndexOf(vector) === undefined ? {} : { idIndex: this.idIndexOf(vector)! }),
        vector,
        filter,
        ...(signal === undefined ? {} : { signal }),
      });
      return result.allowedRows;
    } finally {
      await idMap.close();
    }
  }

  capabilities(): Readonly<WeiSQLCapabilities> {
    const adapter = this.vectorAdapter;
    const exact = adapter === undefined ? this.reader !== undefined : adapter.capabilities.exactSearch;
    return Object.freeze({
      sql: this.sqlAdapter !== undefined,
      vectorExactSearch: exact,
      vectorAnnSearch: adapter !== undefined && !adapter.capabilities.exactSearch,
      hybridSearch: this.reader !== undefined && this.sqlAdapter !== undefined && (adapter === undefined || adapter.capabilities.exactSearch),
      textSearch: this.reader !== undefined && (this.manifest.textIndexes?.length ?? 0) > 0,
      fusionSearch: this.reader !== undefined && ((this.manifest.vectorCollections?.length ?? 0) > 0 || (this.manifest.textIndexes?.length ?? 0) > 0),
      ragSearch: this.reader !== undefined && (this.manifest.textIndexes ?? []).some(index => index.documents !== undefined),
      resourceRange: this.reader !== undefined,
    });
  }
  async close(): Promise<void> {
    if (this.runtimeState === "CLOSED") return;
    if (this.closePromise) return this.closePromise;
    this.runtimeState = "CLOSING";
    this.closePromise = this.finishClose();
    return this.closePromise;
  }
  private async finishClose(): Promise<void> { try { await this.releaseResources(); } finally { this.runtimeState = "CLOSED"; } }
  /** Cached per collection: loading the index once is what makes filtering cheap. */
  private idIndexOf(vector: VectorCollectionDescriptor): SortedIdIndexReader | undefined {
    if (vector.idIndex === undefined || this.reader === undefined || !shouldUseIdIndex(vector.idIndex, vector.idMap)) return undefined;
    const existing = this.idIndexes.get(vector.name);
    if (existing !== undefined) return existing;
    const created = new SortedIdIndexReader(this.reader, vector.idIndex);
    this.idIndexes.set(vector.name, created);
    return created;
  }

  private async releaseResources(): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const index of this.textReaders.values()) pending.push(index.close());
    this.textReaders.clear();
    for (const index of this.idIndexes.values()) pending.push(index.close());
    this.idIndexes.clear();
    if (this.vectorAdapter) pending.push(this.vectorAdapter.close());
    if (this.sqlAdapter) pending.push(this.sqlAdapter.close());
    if (this.reader) pending.push(this.reader.close());
    const results = await Promise.allSettled(pending);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (rejected) throw new WeiSQLError("INTERNAL_ERROR", "Runtime resource cleanup failed", { cause: String(rejected.reason) });
  }
  private ensureOpen(): void { if (this.runtimeState !== "READY") throw new WeiSQLError("DATABASE_CLOSED", "Database is not ready", { state: this.runtimeState }); }
}

export async function open(options: OpenOptions): Promise<WeiSQLDatabase> {
  if (options.mode !== undefined && options.mode !== "readonly") throw new WeiSQLError("INVALID_ARGUMENT", "V1 only supports readonly mode");
  aborted(options.signal);
  if ((options.manifestUrl === undefined) === (options.manifest === undefined)) throw new WeiSQLError("INVALID_ARGUMENT", "Provide exactly one of manifestUrl or manifest");
  if (options.manifest !== undefined) return prepare(validateManifest(options.manifest), options);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new WeiSQLError("INTERNAL_ERROR", "No fetch implementation is available");
  // Keep the global receiver: browsers reject a detached `fetch` with
  // "Illegal invocation".
  const request = fetcher.bind(globalThis);
  let response: Response;
  const requestInit: RequestInit = options.signal ? { signal: options.signal } : {};
  try { response = await request(options.manifestUrl!, requestInit); }
  catch (cause) { if (options.signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Manifest request was cancelled"); throw new WeiSQLError("RESOURCE_NOT_FOUND", "Manifest could not be loaded", { cause: String(cause) }); }
  if (!response.ok) throw new WeiSQLError("RESOURCE_NOT_FOUND", `Manifest request failed with HTTP ${response.status}`, { status: response.status });
  let json: unknown;
  try { json = await response.json(); } catch { throw new WeiSQLError("MANIFEST_INVALID", "Manifest is not valid JSON"); }
  return prepare(validateManifest(json), options);
}

/** Runs L3 verification (when requested) before any adapter sees resource bytes. */
async function prepare(manifest: WeiSQLManifest, options: OpenOptions): Promise<WeiSQLDatabase> {
  const mode = options.verifyChecksums ?? "none";
  if (mode !== "none" && mode !== "manifest" && mode !== "all") {
    throw new WeiSQLError("INVALID_ARGUMENT", "verifyChecksums must be 'none', 'manifest' or 'all'", { mode });
  }
  let reader = options.resourceReader;
  if (reader !== undefined && options.cache !== undefined) {
    reader = new CachedResourceReader({ reader, version: manifest.datasetId, ...options.cache });
  }
  let handedOff = false;
  try {
    if (mode !== "none") {
      if (reader === undefined) throw new WeiSQLError("INVALID_ARGUMENT", "verifyChecksums requires a resourceReader", { mode });
      await verifyManifestResources({
        manifest,
        reader,
        options: { mode, ...(options.signal === undefined ? {} : { signal: options.signal }) },
      });
    }
    handedOff = true;
    return await Database.create(manifest, reader, options.sqlAdapter, options.vectorAdapter, options.signal);
  } catch (cause) {
    // The Runtime owns the reader; a failed open must not leak it. Once
    // Database.create is reached it performs its own cleanup.
    if (!handedOff && reader !== undefined) await reader.close().catch(() => undefined);
    throw cause;
  }
}

function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Operation was cancelled"); }
