import { WeiSQLError } from "./errors.js";
import type { ResourceReader } from "./resource-reader.js";
import type { VectorCollectionDescriptor, VectorHit, VectorMetric } from "./types.js";
import type {
  VectorAdapter,
  VectorAdapterCapabilities,
  VectorAdapterOpenContext,
  VectorAdapterSearchRequest,
} from "./vector-adapter.js";
import { assertBusinessId, materializeVectors, readBusinessIds, throwIfAborted } from "./wasm-vector-support.js";

/** Must match `ABI_VERSION` in `crates/vector-hnsw-wasm/src/lib.rs`. */
const ABI_VERSION = 3;
/** Manifest `index.engine` this adapter can consume. */
const PERSISTED_ENGINE = "weisql-hnsw";
/** Serialized format major version understood by this build. */
const INDEX_FORMAT_MAJOR = "1";
const DEFAULT_BLOCK_SIZE = 1024;
const DEFAULT_OVERSAMPLE = 4;
const DEFAULT_SEED = 0x5eed_5eed;
const METRIC_CODES: Readonly<Record<VectorMetric, number>> = { cosine: 0, l2: 1, ip: 2 };

export interface HnswWasmVectorAdapterOptions {
  /** Compiled module, or raw bytes (for example fetched from a URL). */
  module: WebAssembly.Module | BufferSource;
  /** Links per node above layer zero; layer zero keeps `2 × m`. Defaults to 16. */
  m?: number;
  /** Beam width while building. Defaults to 200. */
  efConstruction?: number;
  /** Beam width while searching. Defaults to 64. */
  efSearch?: number;
  /** Level-assignment seed; the same seed rebuilds the same graph. */
  seed?: number;
  /** Rows decoded per range request while materialising a collection. */
  blockSize?: number;
  /** Candidate multiplier when a row filter is present. Defaults to 4. */
  oversample?: number;
  /**
   * Supplies a serialized graph for a collection (`weisql_hnsw_save` output).
   * Returning `undefined` falls back to building the graph from the vectors.
   * The loaded graph must match the descriptor's row count, dimension and
   * metric; a mismatch or corrupt buffer is rejected, never silently rebuilt.
   */
  loadIndex?: (vector: VectorCollectionDescriptor) => Uint8Array | BufferSource | undefined;
}

interface HnswExports {
  memory: WebAssembly.Memory;
  weisql_hnsw_abi_version(): number;
  weisql_hnsw_alloc(length: number): number;
  weisql_hnsw_dealloc(pointer: number, length: number): void;
  weisql_hnsw_build(
    vectors: number,
    rows: number,
    dimension: number,
    metric: number,
    m: number,
    efConstruction: number,
    efSearch: number,
    seedLow: number,
    seedHigh: number,
  ): number;
  weisql_hnsw_search(query: number, topK: number, outIds: number, outDistances: number): number;
  weisql_hnsw_load(bytes: number, length: number): number;
  weisql_hnsw_dimension(): number;
  weisql_hnsw_len(): number;
  weisql_hnsw_metric(): number;
}

/**
 * Approximate search adapter backed by the pure-Rust HNSW WASM module.
 *
 * The index is built lazily, once per collection, from a materialised
 * `Float32Array` cache. A module instance holds a single graph, so switching
 * between collections rebuilds it; build cost is paid on the first query of a
 * collection. Results are approximate (`exactSearch: false`).
 *
 * Filters use post-filtering: the adapter over-fetches `topK × oversample`
 * neighbours and keeps the allowed rows. That keeps results **incomplete by
 * construction** — the true filtered nearest K may be missing — which is the
 * `postFiltering: true` capability contract.
 */
export async function createHnswWasmVectorAdapter(options: HnswWasmVectorAdapterOptions): Promise<VectorAdapter> {
  const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
  const oversample = options.oversample ?? DEFAULT_OVERSAMPLE;
  const m = options.m ?? 16;
  const efConstruction = options.efConstruction ?? 200;
  const efSearch = options.efSearch ?? 64;
  const seed = options.seed ?? DEFAULT_SEED;
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) {
    throw new WeiSQLError("INVALID_ARGUMENT", "blockSize must be a positive safe integer", { blockSize });
  }
  if (!Number.isSafeInteger(oversample) || oversample <= 0) {
    throw new WeiSQLError("INVALID_ARGUMENT", "oversample must be a positive safe integer", { oversample });
  }
  if (!Number.isSafeInteger(seed) || seed < 0) {
    throw new WeiSQLError("INVALID_ARGUMENT", "seed must be a non-negative safe integer", { seed });
  }

  const instance = await instantiate(options.module);
  const api = instance.exports as unknown as Partial<HnswExports>;
  assertAbi(api);

  let state: "CREATED" | "READY" | "CLOSED" = "CREATED";
  let reader: ResourceReader | undefined;
  const cache = new Map<string, Float32Array>();
  /** Data path of the graph currently living inside the module. */
  let indexKey: string | undefined;

  const capabilities: VectorAdapterCapabilities = Object.freeze({
    engine: "weisql-hnsw-wasm",
    engineVersion: `abi-${ABI_VERSION}`,
    metrics: ["cosine", "l2", "ip"] as const,
    persistedIndex: true,
    metadataFiltering: false,
    postFiltering: true,
    exactSearch: false,
    cancellation: "best-effort" as const,
  });

  return {
    capabilities,
    async open(context: VectorAdapterOpenContext) {
      if (state !== "CREATED") {
        throw new WeiSQLError("INVALID_ARGUMENT", "HNSW vector adapter may only be opened once", { state });
      }
      reader = context.reader;
      state = "READY";
    },
    async search(request: VectorAdapterSearchRequest) {
      if (state !== "READY") {
        throw new WeiSQLError("DATABASE_CLOSED", "HNSW vector adapter is not ready", { state });
      }
      const source = reader!;
      const started = typeof performance === "undefined" ? undefined : performance.now();

      let vectors = cache.get(request.vector.data.path);
      if (vectors === undefined) {
        vectors = await materializeVectors(source, request.vector, blockSize, request.signal);
        cache.set(request.vector.data.path, vectors);
      } else if (vectors.length !== request.vector.count * request.vector.dimension) {
        throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Cached vector block does not match the descriptor", {
          expected: request.vector.count * request.vector.dimension,
          actual: vectors.length,
        });
      }
      throwIfAborted(request.signal);

      const identity = indexIdentity(request);
      if (indexKey !== identity) {
        const provided = options.loadIndex?.(request.vector);
        const prebuilt = provided ?? (await readPersistedIndex(source, request.vector, request.signal));
        if (prebuilt === undefined) {
          buildIndex(api, request, vectors, { m, efConstruction, efSearch, seed });
        } else {
          loadSerialized(api, request, prebuilt);
        }
        indexKey = identity;
      }

      const filtered = request.allowedRows;
      const fetch = filtered === undefined
        ? request.topK
        : Math.min(request.topK * oversample, request.vector.count);
      throwIfAborted(request.signal);

      const raw = searchIndex(api, request, fetch);
      const chosen = filtered === undefined
        ? raw.slice(0, request.topK)
        : raw.filter(hit => filtered.has(hit.row)).slice(0, request.topK);

      const ids = await readBusinessIds(source, request.vector, chosen.map(hit => hit.row), request.signal);
      const elapsedMs = started === undefined || typeof performance === "undefined" ? undefined : performance.now() - started;
      return chosen.map((hit, position): VectorHit => ({
        row: hit.row,
        id: assertBusinessId(ids[position], hit.row),
        distance: hit.distance,
        diagnostics: {
          backend: "rust-hnsw-wasm",
          exact: false,
          ...(filtered === undefined ? {} : { postFiltered: true }),
          ...(elapsedMs === undefined ? {} : { elapsedMs }),
        },
      }));
    },
    async close() {
      state = "CLOSED";
      reader = undefined;
      cache.clear();
      indexKey = undefined;
    },
  };
}

interface HnswSettings {
  m: number;
  efConstruction: number;
  efSearch: number;
  seed: number;
}

/** A graph is bound to one data path *and* one metric, so both identify it. */
function indexIdentity(request: VectorAdapterSearchRequest): string {
  return `${request.vector.data.path}#${request.vector.metric}`;
}

function buildIndex(
  api: HnswExports,
  request: VectorAdapterSearchRequest,
  vectors: Float32Array,
  settings: HnswSettings,
): void {
  const { count, dimension, metric } = request.vector;
  const metricCode = METRIC_CODES[metric];
  if (metricCode === undefined) {
    throw new WeiSQLError("MANIFEST_INVALID", "Unsupported vector metric for the HNSW adapter", { metric });
  }
  const bytes = vectors.byteLength;
  const pointer = api.weisql_hnsw_alloc(bytes);
  if (!pointer) {
    throw new WeiSQLError("INTERNAL_ERROR", "WASM allocation failed for the HNSW build buffer", { bytes });
  }
  try {
    new Float32Array(api.memory.buffer, pointer, vectors.length).set(vectors);
    const code = api.weisql_hnsw_build(
      pointer,
      count,
      dimension,
      metricCode,
      settings.m,
      settings.efConstruction,
      settings.efSearch,
      settings.seed >>> 0,
      Math.floor(settings.seed / 2 ** 32) >>> 0,
    );
    if (code !== 0) throw hnswError(code, "build");
    assertIndexMatches(api, request);
  } finally {
    api.weisql_hnsw_dealloc(pointer, bytes);
  }
}

function loadSerialized(
  api: HnswExports,
  request: VectorAdapterSearchRequest,
  serialized: Uint8Array | BufferSource,
): void {
  const data = serialized instanceof ArrayBuffer
    ? new Uint8Array(serialized)
    : new Uint8Array(serialized.buffer, serialized.byteOffset, serialized.byteLength);
  if (data.byteLength === 0) {
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "The prebuilt HNSW index is empty");
  }
  const pointer = api.weisql_hnsw_alloc(data.byteLength);
  if (!pointer) {
    throw new WeiSQLError("INTERNAL_ERROR", "WASM allocation failed for the prebuilt HNSW index", {
      bytes: data.byteLength,
    });
  }
  try {
    new Uint8Array(api.memory.buffer, pointer, data.byteLength).set(data);
    const code = api.weisql_hnsw_load(pointer, data.byteLength);
    if (code !== 0) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "The prebuilt HNSW index was rejected", {
        code,
        bytes: data.byteLength,
      });
    }
    assertIndexMatches(api, request);
  } finally {
    api.weisql_hnsw_dealloc(pointer, data.byteLength);
  }
}

/** Rejects a graph that does not describe the requested collection. */
  const { count, dimension, metric } = request.vector;
  const metricCode = METRIC_CODES[metric];
  if (
    api.weisql_hnsw_len() !== count ||
    api.weisql_hnsw_dimension() !== dimension ||
    api.weisql_hnsw_metric() !== metricCode
  ) {
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "HNSW index does not match the descriptor", {
      expectedRows: count,
      actualRows: api.weisql_hnsw_len(),
      expectedDimension: dimension,
      actualDimension: api.weisql_hnsw_dimension(),
      expectedMetric: metricCode,
      actualMetric: api.weisql_hnsw_metric(),
    });
  }
}

function searchIndex(api: HnswExports, request: VectorAdapterSearchRequest, fetch: number): { row: number; distance: number }[] {
  const slots = Math.max(1, Math.min(fetch, request.vector.count));
  const queryBytes = request.query.byteLength;
  const idBytes = slots * Uint32Array.BYTES_PER_ELEMENT;
  const distanceBytes = slots * Float64Array.BYTES_PER_ELEMENT;

  const queryPointer = api.weisql_hnsw_alloc(queryBytes);
  const idPointer = api.weisql_hnsw_alloc(idBytes);
  const distancePointer = api.weisql_hnsw_alloc(distanceBytes);
  if (!queryPointer || !idPointer || !distancePointer) {
    freeQuietly(api, queryPointer, queryBytes);
    freeQuietly(api, idPointer, idBytes);
    freeQuietly(api, distancePointer, distanceBytes);
    throw new WeiSQLError("INTERNAL_ERROR", "WASM allocation failed for the HNSW query buffers", {
      queryBytes,
      idBytes,
      distanceBytes,
    });
  }

  try {
    new Float32Array(api.memory.buffer, queryPointer, request.query.length).set(request.query);
    const count = api.weisql_hnsw_search(queryPointer, slots, idPointer, distancePointer);
    if (count < 0) throw hnswError(count, "search");

    const output = api.memory.buffer;
    const ids = new Uint32Array(output, idPointer, count);
    const distances = new Float64Array(output, distancePointer, count);
    const hits = new Array<{ row: number; distance: number }>(count);
    for (let index = 0; index < count; index++) {
      hits[index] = { row: ids[index]!, distance: distances[index]! };
    }
    return hits;
  } finally {
    freeQuietly(api, queryPointer, queryBytes);
    freeQuietly(api, idPointer, idBytes);
    freeQuietly(api, distancePointer, distanceBytes);
  }
}

function hnswError(code: number, phase: "build" | "search"): WeiSQLError {
  switch (code) {
    case -1:
      return new WeiSQLError("INVALID_ARGUMENT", `HNSW ${phase} rejected its arguments`, { code });
    case -2:
      return new WeiSQLError("VECTOR_INVALID_VALUE", "HNSW rejected the vector data", { code });
    case -5:
      return new WeiSQLError("INTERNAL_ERROR", "HNSW search ran before an index was built", { code });
    default:
      return new WeiSQLError("INTERNAL_ERROR", `HNSW ${phase} failed`, { code });
  }
}

function freeQuietly(api: HnswExports, pointer: number, length: number): void {
  if (pointer !== 0) api.weisql_hnsw_dealloc(pointer, length);
}

async function instantiate(module: WebAssembly.Module | BufferSource): Promise<WebAssembly.Instance> {
  try {
    if (module instanceof WebAssembly.Module) return await WebAssembly.instantiate(module, {});
    const result = await WebAssembly.instantiate(module, {});
    return result.instance;
  } catch (cause) {
    throw new WeiSQLError({
      code: "INVALID_ARGUMENT",
      message: "Unable to instantiate the WeiSQL HNSW WASM module",
      cause,
    });
  }
}

function assertAbi(api: Partial<HnswExports>): asserts api is HnswExports {
  if (typeof api.weisql_hnsw_abi_version !== "function") {
    throw new WeiSQLError("INVALID_ARGUMENT", "WASM module is missing weisql_hnsw_abi_version");
  }
  const version = api.weisql_hnsw_abi_version();
  if (version !== ABI_VERSION) {
    throw new WeiSQLError("INVALID_ARGUMENT", "Unsupported WeiSQL HNSW WASM ABI", {
      expected: ABI_VERSION,
      actual: version,
    });
  }
  if (!(api.memory instanceof WebAssembly.Memory)) {
    throw new WeiSQLError("INVALID_ARGUMENT", "WASM module does not export its linear memory");
  }
  if (
    typeof api.weisql_hnsw_alloc !== "function" ||
    typeof api.weisql_hnsw_dealloc !== "function" ||
    typeof api.weisql_hnsw_build !== "function" ||
    typeof api.weisql_hnsw_search !== "function" ||
    typeof api.weisql_hnsw_metric !== "function"
  ) {
    throw new WeiSQLError("INVALID_ARGUMENT", "WASM module is missing required HNSW exports");
  }
}
