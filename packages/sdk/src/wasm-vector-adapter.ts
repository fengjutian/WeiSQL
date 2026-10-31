import { WeiSQLError } from "./errors.js";
import type { ResourceReader } from "./resource-reader.js";
import type { VectorHit, VectorMetric } from "./types.js";
import type {
  VectorAdapter,
  VectorAdapterCapabilities,
  VectorAdapterOpenContext,
  VectorAdapterSearchRequest,
} from "./vector-adapter.js";
import { assertBusinessId, materializeVectors, readBusinessIds, throwIfAborted } from "./wasm-vector-support.js";

/** Must match `ABI_VERSION` in `crates/vector-wasm/src/lib.rs`. */
const ABI_VERSION = 3;
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
        full = await materializeVectors(source, request.vector, blockSize, request.signal);
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

      const hits = runWasm(api, request, plan);
      throwIfAborted(request.signal);

      const ids = await readBusinessIds(source, request.vector, hits.map(hit => hit.row), request.signal);
      const elapsedMs = started === undefined || typeof performance === "undefined" ? undefined : performance.now() - started;
      return hits.map((hit, index): VectorHit => ({
        row: hit.row,
        id: assertBusinessId(ids[index], hit.row),
        distance: hit.distance,
        diagnostics: {
          backend: "rust-wasm-exact",
          exact: true,
          ...(elapsedMs === undefined ? {} : { elapsedMs }),
        },
      }));
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
  /** Original row id for every compacted row; absent for the full cache. */
  rows?: readonly number[];
  /** True when `data` is a compacted subset rather than the full cache. */
  compacted: boolean;
}

function selectRows(request: VectorAdapterSearchRequest, full: Float32Array): RowPlan | undefined {
  const { count, dimension } = request.vector;
  const allowed = request.allowedRows;
  if (allowed === undefined) {
    return { data: full, compacted: false };
  }
  const selected = [...allowed].filter(row => Number.isSafeInteger(row) && row >= 0 && row < count).sort((a, b) => a - b);
  if (selected.length === 0) return undefined;
  const compacted = new Float32Array(selected.length * dimension);
  selected.forEach((row, index) => {
    compacted.set(full.subarray(row * dimension, (row + 1) * dimension), index * dimension);
  });
  return { data: compacted, rows: selected, compacted: true };
}

interface RawHit {
  row: number;
  distance: number;
}

function runWasm(api: WasmExports, request: VectorAdapterSearchRequest, plan: RowPlan): RawHit[] {
  const { dimension, metric } = request.vector;
  const metricCode = METRIC_CODES[metric];
  if (metricCode === undefined) {
    throw new WeiSQLError("MANIFEST_INVALID", "Unsupported vector metric for the WASM adapter", { metric });
  }
  const rowCount = plan.compacted ? plan.rows!.length : request.vector.count;
  const slots = Math.min(request.topK, rowCount);
  if (slots <= 0) return [];

  const data = plan.data;
  const vectorBytes = data.byteLength;
  const queryBytes = request.query.byteLength;
  const idBytes = slots * Uint32Array.BYTES_PER_ELEMENT;
  const distanceBytes = slots * Float64Array.BYTES_PER_ELEMENT;

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
      rowCount,
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
    const distances = new Float64Array(output, distancePointer, count);
    const hits: RawHit[] = new Array(count);
    for (let index = 0; index < count; index++) {
      const local = ids[index]!;
      hits[index] = {
        row: plan.compacted ? plan.rows![local]! : local,
        distance: distances[index]!,
      };
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
