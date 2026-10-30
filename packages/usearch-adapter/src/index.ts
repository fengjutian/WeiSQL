import { Index } from "usearch";
import type { MetricKind, ScalarKind } from "usearch";

import { IndexedIdMapReader } from "@weisql/sdk";
import type { ResourceReader, VectorAdapter, VectorAdapterCapabilities, VectorAdapterSearchRequest, VectorCollectionDescriptor, VectorHit, VectorMetric, WeiSQLManifest } from "@weisql/sdk";
import { WeiSQLError } from "@weisql/sdk";

export interface USearchAdapterOptions {
  /** HNSW graph degree; defaults to 16. */
  connectivity?: number;
  /** Candidate list during insertion; defaults to 128. */
  expansionAdd?: number;
  /** Candidate list during search; defaults to 64. Recall depends on this. */
  expansionSearch?: number;
  /** Rows added per batch while building; defaults to 4096. */
  buildBatchRows?: number;
}

/**
 * USearch metric per WeiSQL metric, plus the distance correction required by the
 * public contract.
 *
 * Measured against the SDK's own `vectorDistance()`:
 * - `cos` returns `1 - cosine similarity`, which matches directly.
 * - `l2sq` returns the **squared** Euclidean distance, so the result is sqrt-ed.
 * - `ip` returns `1 - dot product`, so subtracting 1 yields the required `-dot`.
 */
const METRIC_MAP: Record<VectorMetric, { usearch: MetricKind; correct: (distance: number) => number }> = {
  cosine: { usearch: "cos" as MetricKind, correct: distance => distance },
  l2: { usearch: "l2sq" as MetricKind, correct: distance => Math.sqrt(Math.max(0, distance)) },
  ip: { usearch: "ip" as MetricKind, correct: distance => distance - 1 },
};

interface CollectionIndex {
  index: Index;
  metric: VectorMetric;
  count: number;
}

/**
 * ANN adapter over an in-memory USearch index built from the package vectors.
 *
 * Deliberate scope limits, all reported through `capabilities`:
 * - `persistedIndex: false` — the index is rebuilt on first search, because the
 *   Manifest cannot yet describe HNSW parameters.
 * - `exactSearch: false` — results are approximate; `diagnostics.exact` is false.
 * - `metadataFiltering: false` — the Runtime refuses filtered queries before
 *   calling an approximate adapter.
 *
 * Build cost is real: one full vector read plus index construction, paid on the
 * first search per collection.
 */
export function createUSearchAdapter(options: USearchAdapterOptions = {}): VectorAdapter {
  const connectivity = positive(options.connectivity ?? 16, "connectivity");
  const expansionAdd = positive(options.expansionAdd ?? 128, "expansionAdd");
  const expansionSearch = positive(options.expansionSearch ?? 64, "expansionSearch");
  const buildBatchRows = positive(options.buildBatchRows ?? 4096, "buildBatchRows");

  let state: "CREATED" | "READY" | "CLOSED" = "CREATED";
  let manifest: Readonly<WeiSQLManifest> | undefined;
  let reader: ResourceReader | undefined;
  const indexes = new Map<string, CollectionIndex>();

  const capabilities: VectorAdapterCapabilities = Object.freeze({
    engine: "usearch",
    metrics: ["cosine", "l2", "ip"] as const,
    persistedIndex: false,
    metadataFiltering: false,
    exactSearch: false,
    cancellation: "unsupported" as const,
  });

  async function buildIndex(collection: VectorCollectionDescriptor, signal: AbortSignal | undefined): Promise<CollectionIndex> {
    const mapping = METRIC_MAP[collection.metric];
    if (mapping === undefined) throw new WeiSQLError("MANIFEST_INVALID", "Unsupported metric for USearch", { metric: collection.metric });
    const index = new Index({
      metric: mapping.usearch,
      dimensions: collection.dimension,
      quantization: "f32" as ScalarKind,
      connectivity,
      expansion_add: expansionAdd,
      expansion_search: expansionSearch,
      multi: false,
    });
    const rowBytes = collection.dimension * 4;
    const source = reader!;
    for (let startRow = 0; startRow < collection.count; startRow += buildBatchRows) {
      if (signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Index build was cancelled");
      const rows = Math.min(buildBatchRows, collection.count - startRow);
      const bytes = await source.readRange(
        collection.data.path,
        { start: startRow * rowBytes, end: (startRow + rows) * rowBytes },
        signal === undefined ? undefined : { signal },
      );
      if (bytes.byteLength !== rows * rowBytes) {
        throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Vector block length mismatch while building the index", {
          expected: rows * rowBytes,
          actual: bytes.byteLength,
        });
      }
      // Little-endian Float32 on all supported platforms; this mirrors the file layout.
      const vectors = new Float32Array(bytes.buffer, bytes.byteOffset, rows * collection.dimension);
      const keys = new BigUint64Array(rows);
      for (let row = 0; row < rows; row++) keys[row] = BigInt(startRow + row);
      index.add(keys, vectors);
    }
    return { index, metric: collection.metric, count: collection.count };
  }

  return {
    capabilities,
    async open(context) {
      if (state !== "CREATED") throw new WeiSQLError("INVALID_ARGUMENT", "USearch adapter may only be opened once", { state });
      manifest = context.manifest;
      reader = context.reader;
      state = "READY";
    },
    async search(request: VectorAdapterSearchRequest): Promise<readonly VectorHit[]> {
      if (state !== "READY") throw new WeiSQLError("DATABASE_CLOSED", "USearch adapter is not ready", { state });
      if (request.allowedRows !== undefined) {
        throw new WeiSQLError("SQL_UNSUPPORTED", "An approximate adapter cannot honour a filtered row set", { engine: capabilities.engine });
      }
      if (manifest === undefined || reader === undefined) throw new WeiSQLError("INTERNAL_ERROR", "USearch adapter was not opened");
      const { vector, query, topK, signal } = request;
      if (signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Search was cancelled before execution");
      if (query.length !== vector.dimension) {
        throw new WeiSQLError("VECTOR_DIMENSION_MISMATCH", "Query dimension does not match the collection", { expected: vector.dimension, actual: query.length });
      }

      const started = typeof performance === "undefined" ? 0 : performance.now();
      let entry = indexes.get(vector.name);
      if (entry === undefined) {
        entry = await buildIndex(vector, signal);
        indexes.set(vector.name, entry);
      }

      const matches = entry.index.search(query, Math.min(topK, entry.count), 0);
      const rows = Array.from(matches.keys, key => Number(key));
      const idMap = new IndexedIdMapReader(reader, {
        dataPath: vector.idMap.data.path,
        offsetsPath: vector.idMap.offsets.path,
        count: vector.idMap.count,
        dataBytes: vector.idMap.data.bytes,
        offsetsBytes: vector.idMap.offsets.bytes,
      });
      let ids: readonly (string | number)[];
      try {
        ids = await idMap.getIdsByRows(rows, signal === undefined ? undefined : { signal });
      } finally {
        await idMap.close();
      }
      const correct = METRIC_MAP[entry.metric].correct;
      const elapsedMs = typeof performance === "undefined" ? undefined : performance.now() - started;
      return rows.map((row, position) => ({
        row,
        id: ids[position]!,
        distance: correct(Number(matches.distances[position])),
        diagnostics: {
          backend: "usearch-hnsw",
          exact: false,
          ...(elapsedMs === undefined ? {} : { elapsedMs }),
        },
      }));
    },
    async close() {
      if (state === "CLOSED") return;
      indexes.clear();
      manifest = undefined;
      reader = undefined;
      state = "CLOSED";
    },
  };
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new WeiSQLError("INVALID_ARGUMENT", `${name} must be a positive safe integer`, { [name]: value });
  return value;
}
