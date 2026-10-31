import { WeiSQLError } from "./errors.js";
import { IndexedIdMapReader } from "./indexed-id-map-reader.js";
import type { ResourceReader } from "./resource-reader.js";
import type { VectorHit, VectorMetric } from "./types.js";
import type {
  VectorAdapter,
  VectorAdapterCapabilities,
  VectorAdapterOpenContext,
  VectorAdapterSearchRequest,
} from "./vector-adapter.js";
import { VectorBlockReader } from "./vector-block-reader.js";

/** Must match `ABI_VERSION` in `crates/vector-wasm/src/lib.rs`. */
const ABI_VERSION = 2;
const DEFAULT_BLOCK_SIZE = 1024;
const METRIC_CODES: Readonly<Record<VectorMetric, number>> = { cosine: 0, l2: 1, ip: 2 };

export interface WasmVectorAdapterOptions {
  /** Compiled module, or raw bytes (for example fetched from a URL). */
  module: WebAssembly.Module | BufferSource;
  /** Rows decoded per range request while materialising a collection. */
  blockSize?: number;
}

interface WasmExports {
  memory: WebAssembly.Memory;
  weisql_abi_version(): number;
  weisql_alloc(length: number): number;
  weisql_dealloc(pointer: number, length: number): void;
  weisql_search_topk(
    vectors: number,
    rows: number,
    dimension: number,
    query: number,
    topK: number,
    metric: number,
    outIds: number,
    outDistances: number,
  ): number;
}

/**
 * Exact search adapter backed by the `crates/vector-wasm` artifact.
 *
 * The module has no imports and no wasm-bindgen runtime, so callers only need
 * to supply its bytes. Vectors are materialised once per collection and kept in
 * a `Float32Array` cache; each search copies them into linear memory, runs the
 * Rust scan, and copies back at most `topK` hits. Memory therefore scales with
 * the collection (`count × dimension × 4` bytes), which is the same order the
 * SDK baseline needs for one decoded block but held for the whole collection.
 */
export async function createWasmVectorAdapter(options: WasmVectorAdapterOptions): Promise<VectorAdapter> {
  const blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) {
    throw new WeiSQLError("INVALID_ARGUMENT", "blockSize must be a positive safe integer", { blockSize });
  }
  const instance = await instantiate(options.module);
  const api = instance.exports as unknown as Partial<WasmExports>;
  assertAbi(api);

  let state: "CREATED" | "READY" | "CLOSED" = "CREATED";
  let reader: ResourceReader | undefined;
  /** Materialised collections keyed by data path; packages are immutable. */
  const cache = new Map<string, Float32Array>();

  const capabilities: VectorAdapterCapabilities = Object.freeze({
    engine: "weisql-wasm-exact",
    engineVersion: `abi-${ABI_VERSION}`,
    metrics: ["cosine", "l2", "ip"] as const,
    persistedIndex: false,
    metadataFiltering: false,
    postFiltering: false,
    exactSearch: true,
    cancellation: "best-effort" as const,
  });

  return {
    capabilities,
    async open(context: VectorAdapterOpenContext) {
      if (state !== "CREATED") {
        throw new WeiSQLError("INVALID_ARGUMENT", "WASM vector adapter may only be opened once", { state });
      }
      reader = context.reader;
      state = "READY";
    },
    async search(request: VectorAdapterSearchRequest) {
      if (state !== "READY") {
        throw new WeiSQLError("DATABASE_CLOSED", "WASM vector adapter is not ready", { state });
      }
      const source = reader!;
      const started = typeof performance === "undefined" ? undefined : performance.now();

      let full = cache.get(request.vector.data.path);
      if (full === undefined) {
        full = await materialize(source, request, blockSize);
        cache.set(request.vector.data.path, full);
      } else if (full.length !== request.vector.count * request.vector.dimension) {
        throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Cached vector block does not match the descriptor", {
          expected: request.vector.count * request.vector.dimension,
          actual: full.length,
        });
      }

      const plan = selectRows(request, full);
      if (plan === undefined) return [];
      throwIfAborted(request.signal);

      const hits = runWasm(api, request, plan.data, plan.rows, plan.compacted);
      throwIfAborted(request.signal);

      const idMap = new IndexedIdMapReader(source, {
        dataPath: request.vector.idMap.data.path,
        offsetsPath: request.vector.idMap.offsets.path,
        count: request.vector.idMap.count,
        dataBytes: request.vector.idMap.data.bytes,
        offsetsBytes: request.vector.idMap.offsets.bytes,
      });
      try {
        const ids = await idMap.getIdsByRows(
          hits.map(hit => hit.row),
          request.signal === undefined ? undefined : { signal: request.signal },
        );
        if (ids.length !== hits.length) {
          throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID map count does not match the final candidates", {
            expected: hits.length,
            actual: ids.length,
          });
        }
        const elapsedMs = started === undefined || typeof performance === "undefined" ? undefined : performance.now() - started;
        return hits.map((hit, index): VectorHit => {
          const id = ids[index];
          if ((typeof id !== "string" || id.length === 0) && (typeof id !== "number" || !Number.isSafeInteger(id))) {
            throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID map contains an invalid business ID", { row: hit.row });
          }
          return {
            row: hit.row,
            id,
            distance: hit.distance,
            diagnostics: {
              backend: "rust-wasm-exact",
              exact: true,
              ...(elapsedMs === undefined ? {} : { elapsedMs }),
            },
          };
        });
      } finally {
        await idMap.close();
      }
    },
    async close() {
      state = "CLOSED";
      reader = undefined;
      cache.clear();
    },
  };
}

interface RowPlan {
  /** Values passed to the module: the full cache or a compacted copy. */
  data: Float32Array;
  /** Original row id for every row in `data`. */
  rows: readonly number[];
  /** True when `data` is a compacted subset rather than the full cache. */
  compacted: boolean;
}

function selectRows(request: VectorAdapterSearchRequest, full: Float32Array): RowPlan | undefined {
  const { count, dimension } = request.vector;
  const allowed = request.allowedRows;
  if (allowed === undefined) {
    const rows = Array.from({ length: count }, (_, row) => row);
    return { data: full, rows, compacted: false };
  }
  const selected = [...allowed].filter(row => Number.isSafeInteger(row) && row >= 0 && row < count).sort((a, b) => a - b);
  if (selected.length === 0) return undefined;
  const compacted = new Float32Array(selected.length * dimension);
  selected.forEach((row, index) => {
    compacted.set(full.subarray(row * dimension, (row + 1) * dimension), index * dimension);
  });
  return { data: compacted, rows: selected, compacted: true };
}

async function materialize(
  source: ResourceReader,
  request: VectorAdapterSearchRequest,
  blockSize: number,
): Promise<Float32Array> {
  const { count, dimension, data } = request.vector;
  const reader = new VectorBlockReader(source, { path: data.path, count, dimension, bytes: data.bytes });
  const values = new Float32Array(count * dimension);
  let written = 0;
  for (let start = 0; start < count; start += blockSize) {
    throwIfAborted(request.signal);
    const block = await reader.readBlock(
      start,
      Math.min(blockSize, count - start),
      request.signal === undefined ? undefined : { signal: request.signal },
    );
    values.set(block.values, written * dimension);
    written += block.count;
  }
  if (written !== count) {
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Vector scan did not cover the whole collection", {
      expected: count,
      actual: written,
    });
  }
  return values;
}

interface RawHit {
  row: number;
  distance: number;
}

function runWasm(
  api: WasmExports,
  request: VectorAdapterSearchRequest,
  data: Float32Array,
  rows: readonly number[],
  compacted: boolean,
): RawHit[] {
  const { dimension, metric } = request.vector;
  const metricCode = METRIC_CODES[metric];
  if (metricCode === undefined) {
    throw new WeiSQLError("MANIFEST_INVALID", "Unsupported vector metric for the WASM adapter", { metric });
  }
  const slots = Math.min(request.topK, rows.length);
  if (slots <= 0) return [];

  const vectorBytes = data.byteLength;
  const queryBytes = request.query.byteLength;
  const idBytes = slots * Uint32Array.BYTES_PER_ELEMENT;
  const distanceBytes = slots * Float32Array.BYTES_PER_ELEMENT;

  const vectorPointer = api.weisql_alloc(vectorBytes);
  const queryPointer = api.weisql_alloc(queryBytes);
  const idPointer = api.weisql_alloc(idBytes);
  const distancePointer = api.weisql_alloc(distanceBytes);
  if (!vectorPointer || !queryPointer || !idPointer || !distancePointer) {
    freeQuietly(api, vectorPointer, vectorBytes);
    freeQuietly(api, queryPointer, queryBytes);
    freeQuietly(api, idPointer, idBytes);
    freeQuietly(api, distancePointer, distanceBytes);
    throw new WeiSQLError("INTERNAL_ERROR", "WASM allocation failed for the vector search buffers", {
      vectorBytes,
      queryBytes,
      idBytes,
      distanceBytes,
    });
  }

  try {
    // Views are created after every allocation: growing memory detaches buffers.
    const input = api.memory.buffer;
    new Float32Array(input, vectorPointer, data.length).set(data);
    new Float32Array(input, queryPointer, request.query.length).set(request.query);

    const count = api.weisql_search_topk(
      vectorPointer,
      rows.length,
      dimension,
      queryPointer,
      request.topK,
      metricCode,
      idPointer,
      distancePointer,
    );
    if (count < 0) throw wasmError(count, request);

    // The scan may have grown memory, so read from a fresh buffer.
    const output = api.memory.buffer;
    const ids = new Uint32Array(output, idPointer, count);
    const distances = new Float32Array(output, distancePointer, count);
    const hits: RawHit[] = new Array(count);
    for (let index = 0; index < count; index++) {
      const local = ids[index]!;
      hits[index] = { row: compacted ? rows[local]! : local, distance: distances[index]! };
    }
    return hits;
  } finally {
    freeQuietly(api, vectorPointer, vectorBytes);
    freeQuietly(api, queryPointer, queryBytes);
    freeQuietly(api, idPointer, idBytes);
    freeQuietly(api, distancePointer, distanceBytes);
  }
}

function wasmError(code: number, request: VectorAdapterSearchRequest): WeiSQLError {
  switch (code) {
    case -4:
      return new WeiSQLError("INVALID_ARGUMENT", "topK is outside the range supported by the WASM adapter", {
        topK: request.topK,
      });
    case -3:
      return new WeiSQLError("VECTOR_INVALID_VALUE", "Query vector is invalid for the selected metric", {
        metric: request.vector.metric,
      });
    case -2:
      return new WeiSQLError("VECTOR_INVALID_VALUE", "Vector data is invalid for the selected metric", {
        metric: request.vector.metric,
      });
    default:
      return new WeiSQLError("INVALID_ARGUMENT", "WASM vector search rejected its arguments", { code });
  }
}

function freeQuietly(api: WasmExports, pointer: number, length: number): void {
  if (pointer !== 0) api.weisql_dealloc(pointer, length);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Vector search was cancelled");
}

async function instantiate(module: WebAssembly.Module | BufferSource): Promise<WebAssembly.Instance> {
  try {
    if (module instanceof WebAssembly.Module) return await WebAssembly.instantiate(module, {});
    const result = await WebAssembly.instantiate(module, {});
    return result.instance;
  } catch (cause) {
    throw new WeiSQLError({
      code: "INVALID_ARGUMENT",
      message: "Unable to instantiate the WeiSQL vector WASM module",
      cause,
    });
  }
}

function assertAbi(api: Partial<WasmExports>): asserts api is WasmExports {
  if (typeof api.weisql_abi_version !== "function") {
    throw new WeiSQLError("INVALID_ARGUMENT", "WASM module is missing weisql_abi_version");
  }
  const version = api.weisql_abi_version();
  if (version !== ABI_VERSION) {
    throw new WeiSQLError("INVALID_ARGUMENT", "Unsupported WeiSQL vector WASM ABI", {
      expected: ABI_VERSION,
      actual: version,
    });
  }
  if (!(api.memory instanceof WebAssembly.Memory)) {
    throw new WeiSQLError("INVALID_ARGUMENT", "WASM module does not export its linear memory");
  }
  if (
    typeof api.weisql_alloc !== "function" ||
    typeof api.weisql_dealloc !== "function" ||
    typeof api.weisql_search_topk !== "function"
  ) {
    throw new WeiSQLError("INVALID_ARGUMENT", "WASM module is missing required exports");
  }
}
