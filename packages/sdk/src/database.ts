import { WeiSQLError } from "./errors.js";
import { CachedResourceReader } from "./cached-resource-reader.js";
import { exactVectorSearch } from "./exact-vector-search.js";
import { verifyManifestResources } from "./integrity.js";
import { IndexedIdMapReader } from "./indexed-id-map-reader.js";
import { validateManifest } from "./manifest.js";
import type { ResourceReader } from "./resource-reader.js";
import type { SqlAdapter } from "./sql-adapter.js";
import type { OpenOptions, QueryOptions, RuntimeState, SQLValue, VectorHit, VectorSearchOptions, WeiSQLCapabilities, WeiSQLManifest } from "./types.js";
import { VectorBlockReader } from "./vector-block-reader.js";
import { candidateCapFor, exactFilterFirst, vectorFirst } from "./hybrid-executor.js";

export interface WeiSQLDatabase {
  readonly manifest: Readonly<WeiSQLManifest>;
  readonly state: RuntimeState;
  sql<T extends Record<string, unknown> = Record<string, unknown>>(query: string, params?: readonly SQLValue[], options?: QueryOptions): Promise<readonly T[]>;
  readonly vector: { search(vectorName: string, queryVector: Float32Array | readonly number[], options?: VectorSearchOptions): Promise<readonly VectorHit[]> };
  capabilities(): Readonly<WeiSQLCapabilities>;
  close(): Promise<void>;
}

class Database implements WeiSQLDatabase {
  private runtimeState: RuntimeState = "OPENING";
  private closePromise: Promise<void> | undefined;
  readonly manifest: Readonly<WeiSQLManifest>;
  readonly vector;
  private constructor(manifest: WeiSQLManifest, private readonly reader?: ResourceReader, private readonly sqlAdapter?: SqlAdapter) {
    this.manifest = manifest;
    this.vector = { search: this.search.bind(this) };
  }
  static async create(manifest: WeiSQLManifest, reader: ResourceReader | undefined, sqlAdapter: SqlAdapter | undefined, signal?: AbortSignal): Promise<Database> {
    if (sqlAdapter && !reader) throw new WeiSQLError("INVALID_ARGUMENT", "A SQL adapter requires a resourceReader");
    const database = new Database(manifest, reader, sqlAdapter);
    try {
      if (sqlAdapter && reader) await sqlAdapter.open({ manifest, reader, ...(signal ? { signal } : {}) });
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
          ...(allowed === undefined ? {} : { isAllowed: (row: number) => allowed.has(row) }),
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

  capabilities(): Readonly<WeiSQLCapabilities> {
    return Object.freeze({
      sql: this.sqlAdapter !== undefined,
      vectorExactSearch: this.reader !== undefined,
      vectorAnnSearch: false,
      hybridSearch: this.reader !== undefined && this.sqlAdapter !== undefined,
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
  private async releaseResources(): Promise<void> {
    const pending: Promise<void>[] = [];
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
    return await Database.create(manifest, reader, options.sqlAdapter, options.signal);
  } catch (cause) {
    // The Runtime owns the reader; a failed open must not leak it. Once
    // Database.create is reached it performs its own cleanup.
    if (!handedOff && reader !== undefined) await reader.close().catch(() => undefined);
    throw cause;
  }
}

function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Operation was cancelled"); }
