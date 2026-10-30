import { WeiSQLError } from "./errors.js";
import { exactVectorSearch } from "./exact-vector-search.js";
import { IndexedIdMapReader } from "./indexed-id-map-reader.js";
import type { ResourceReader } from "./resource-reader.js";
import type { VectorMetric, VectorCollectionDescriptor, VectorHit, WeiSQLManifest } from "./types.js";
import { VectorBlockReader } from "./vector-block-reader.js";

export interface VectorAdapterCapabilities {
  engine: string;
  engineVersion?: string;
  metrics: readonly VectorMetric[];
  /** Adapter can load a persisted index described by the Manifest. */
  persistedIndex: boolean;
  /** Adapter implements the V1 equality-filter semantics itself. */
  metadataFiltering: boolean;
  /** True only for a real brute-force scan; ANN adapters must report false. */
  exactSearch: boolean;
  cancellation: "native" | "best-effort" | "unsupported";
}

export interface VectorAdapterOpenContext {
  manifest: Readonly<WeiSQLManifest>;
  reader: ResourceReader;
  signal?: AbortSignal;
}

export interface VectorAdapterSearchRequest {
  /** Resolved collection descriptor; adapters never re-resolve names. */
  vector: VectorCollectionDescriptor;
  query: Float32Array;
  topK: number;
  /**
   * Restrict the scan to these vector rows. The Runtime already resolved the
   * filter to a row set, so adapters do not need SQL or metadata access.
   */
  allowedRows?: ReadonlySet<number>;
  signal?: AbortSignal;
}

/**
 * Engine boundary for vector search.
 *
 * The Runtime keeps ownership of argument validation, filter resolution and
 * business-ID semantics; an adapter only turns (query, topK, row restriction)
 * into ranked rows with distances. `exactSearch` decides whether results may be
 * presented as exact, and it must not be inferred from "returns K results".
 */
export interface VectorAdapter {
  readonly capabilities: Readonly<VectorAdapterCapabilities>;
  open(context: VectorAdapterOpenContext): Promise<void>;
  search(request: VectorAdapterSearchRequest): Promise<readonly VectorHit[]>;
  close(): Promise<void>;
}

export interface ExactVectorAdapterOptions {
  /** Rows decoded per range request; defaults to the SDK baseline of 1024. */
  blockSize?: number;
}

/**
 * Reference implementation: the in-SDK exact scan, expressed through the
 * adapter contract. It exists to pin the interface shape and to give the Runtime
 * a trustworthy default; ANN adapters must report `exactSearch: false`.
 */
export function createExactVectorAdapter(options: ExactVectorAdapterOptions = {}): VectorAdapter {
  const blockSize = options.blockSize ?? 1024;
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) {
    throw new WeiSQLError("INVALID_ARGUMENT", "blockSize must be a positive safe integer", { blockSize });
  }
  let state: "CREATED" | "READY" | "CLOSED" = "CREATED";
  let reader: ResourceReader | undefined;
  const capabilities: VectorAdapterCapabilities = Object.freeze({
    engine: "weisql-exact",
    metrics: ["cosine", "l2", "ip"] as const,
    persistedIndex: false,
    metadataFiltering: false,
    exactSearch: true,
    cancellation: "best-effort" as const,
  });

  return {
    capabilities,
    async open(context) {
      if (state !== "CREATED") throw new WeiSQLError("INVALID_ARGUMENT", "Exact vector adapter may only be opened once", { state });
      reader = context.reader;
      state = "READY";
    },
    async search({ vector, query, topK, allowedRows, signal }) {
      if (state !== "READY") throw new WeiSQLError("DATABASE_CLOSED", "Exact vector adapter is not ready", { state });
      const source = reader!;
      const started = typeof performance === "undefined" ? 0 : performance.now();
      const idMap = new IndexedIdMapReader(source, {
        dataPath: vector.idMap.data.path,
        offsetsPath: vector.idMap.offsets.path,
        count: vector.idMap.count,
        dataBytes: vector.idMap.data.bytes,
        offsetsBytes: vector.idMap.offsets.bytes,
      });
      try {
        const hits = await exactVectorSearch({
          reader: new VectorBlockReader(source, {
            path: vector.data.path,
            count: vector.count,
            dimension: vector.dimension,
            bytes: vector.data.bytes,
          }),
          idMap,
          query,
          collectionCount: vector.count,
          dimension: vector.dimension,
          search: {
            topK,
            metric: vector.metric,
            blockSize,
            ...(signal === undefined ? {} : { signal }),
            ...(allowedRows === undefined ? {} : { isAllowed: (row: number) => allowedRows.has(row) }),
          },
        });
        const elapsedMs = typeof performance === "undefined" ? undefined : performance.now() - started;
        return hits.map(hit => ({
          ...hit,
          diagnostics: {
            backend: "typescript-exact",
            exact: true,
            ...(elapsedMs === undefined ? {} : { elapsedMs }),
          },
        }));
      } finally {
        await idMap.close();
      }
    },
    async close() {
      state = "CLOSED";
      reader = undefined;
    },
  };
}
