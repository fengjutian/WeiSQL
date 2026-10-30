import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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
  /** Candidate list during search; defaults to 512. Recall depends on this. */
  expansionSearch?: number;
  /** Rows added per batch while building; defaults to 4096. */
  buildBatchRows?: number;
  /**
   * How filtered queries are handled:
   * - `"reject"` (default): throw `SQL_UNSUPPORTED`. Post-filtering an
   *   approximate candidate list cannot produce the filtered nearest K.
   * - `"post-filter"`: widen the candidate window until enough allowed rows are
   *   found, then return them. Results are **incomplete by construction** and
   *   carry `diagnostics.postFiltered = true`.
   */
  filtering?: "reject" | "post-filter";
  /** Candidate multiplier for post-filtering; defaults to 8. */
  filterOversample?: number;
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
  /** True when the index came from the package instead of being built locally. */
  persisted: boolean;
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
 * first search per collection. When the Manifest declares an index for a
 * collection, that file is loaded instead and the build is skipped.
 */
export function createUSearchAdapter(options: USearchAdapterOptions = {}): VectorAdapter {
  const connectivity = positive(options.connectivity ?? 16, "connectivity");
  const expansionAdd = positive(options.expansionAdd ?? 128, "expansionAdd");
  const expansionSearch = positive(options.expansionSearch ?? 512, "expansionSearch");
  const buildBatchRows = positive(options.buildBatchRows ?? 4096, "buildBatchRows");
  const filtering = options.filtering ?? "reject";
  if (filtering !== "reject" && filtering !== "post-filter") {
    throw new WeiSQLError("INVALID_ARGUMENT", "filtering must be 'reject' or 'post-filter'", { filtering });
  }
  const filterOversample = positive(options.filterOversample ?? 8, "filterOversample");

  let state: "CREATED" | "READY" | "CLOSED" = "CREATED";
  let manifest: Readonly<WeiSQLManifest> | undefined;
  let reader: ResourceReader | undefined;
  const indexes = new Map<string, CollectionIndex>();
  const tempDirectories: string[] = [];

  const capabilities: VectorAdapterCapabilities = Object.freeze({
    engine: "usearch",
    metrics: ["cosine", "l2", "ip"] as const,
    persistedIndex: true,
    metadataFiltering: false,
    postFiltering: filtering === "post-filter",
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
    return { index, metric: collection.metric, count: collection.count, persisted: false };
  }

  /**
   * Loads the index described by the Manifest.
   *
   * USearch can only load from a path, not from bytes, so the resource is written
   * to a private temporary file and kept until `close()`. Building parameters come
   * from `index.params`; without them the file cannot be reconstructed, and
   * guessing would silently change recall.
   */
  async function loadPersisted(collection: VectorCollectionDescriptor, signal: AbortSignal | undefined): Promise<CollectionIndex> {
    const descriptor = collection.index!;
    if (descriptor.engine !== capabilities.engine) {
      throw new WeiSQLError("INDEX_NOT_FOUND", "Manifest index engine is not supported by this adapter", {
        expected: capabilities.engine,
        actual: descriptor.engine,
      });
    }
    const params = descriptor.params ?? {};
    const fileConnectivity = numberParam(params, "connectivity", connectivity);
    const fileExpansionAdd = numberParam(params, "expansion_add", expansionAdd);
    const fileExpansionSearch = numberParam(params, "expansion_search", expansionSearch);
    const bytes = await reader!.read(descriptor.file.path, signal === undefined ? undefined : { signal });
    if (bytes.byteLength !== descriptor.file.bytes) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Persisted index byte length does not match the Manifest", {
        declared: descriptor.file.bytes,
        actual: bytes.byteLength,
      });
    }
    const directory = await mkdtemp(path.join(tmpdir(), "weisql-usearch-"));
    const file = path.join(directory, "index.bin");
    await writeFile(file, bytes);
    const index = new Index({
      metric: METRIC_MAP[collection.metric].usearch,
      dimensions: collection.dimension,
      quantization: "f32" as ScalarKind,
      connectivity: fileConnectivity,
      expansion_add: fileExpansionAdd,
      expansion_search: fileExpansionSearch,
      multi: false,
    });
    try {
      index.load(file);
    } catch (cause) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Persisted index could not be loaded", { cause: String(cause) });
    }
    tempDirectories.push(directory);
    if (index.size() !== collection.count) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Persisted index vector count does not match the Manifest", {
        expected: collection.count,
        actual: index.size(),
      });
    }
    return { index, metric: collection.metric, count: collection.count, persisted: true };
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
      const allowed = request.allowedRows;
      if (allowed !== undefined && filtering !== "post-filter") {
        throw new WeiSQLError("SQL_UNSUPPORTED", "This adapter is configured to reject filtered row sets", { engine: capabilities.engine });
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
        entry = vector.index === undefined ? await buildIndex(vector, signal) : await loadPersisted(vector, signal);
        indexes.set(vector.name, entry);
      }

      // HNSW can only return a prefix of its ranking, so a filtered query widens
      // the candidate window until enough allowed rows are found or the whole
      // collection has been considered. Completeness is still not guaranteed.
      let candidates = Math.min(topK, entry.count);
      if (allowed !== undefined) candidates = Math.min(entry.count, Math.max(topK, topK * filterOversample));
      let rows: number[] = [];
      let distances: number[] = [];
      for (;;) {
        const matches = entry.index.search(query, candidates, 0);
        const allRows = Array.from(matches.keys, key => Number(key));
        const allDistances = Array.from(matches.distances, value => Number(value));
        if (allowed === undefined) {
          rows = allRows.slice(0, topK);
          distances = allDistances.slice(0, topK);
          break;
        }
        const kept: number[] = [];
        const keptDistances: number[] = [];
        for (let position = 0; position < allRows.length; position++) {
          const row = allRows[position]!;
          if (!allowed.has(row)) continue;
          kept.push(row);
          keptDistances.push(allDistances[position]!);
          if (kept.length === topK) break;
        }
        rows = kept;
        distances = keptDistances;
        if (kept.length >= topK || candidates >= entry.count) break;
        if (signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Search was cancelled");
        candidates = Math.min(entry.count, candidates * 2);
      }

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
        distance: correct(distances[position]!),
        diagnostics: {
          backend: "usearch-hnsw",
          exact: false,
          ...(allowed === undefined ? {} : { postFiltered: true, candidatesScanned: candidates, filteredCandidates: rows.length }),
          ...(elapsedMs === undefined ? {} : { elapsedMs }),
        },
      }));
    },
    async close() {
      if (state === "CLOSED") return;
      indexes.clear();
      manifest = undefined;
      reader = undefined;
      const directories = tempDirectories.splice(0, tempDirectories.length);
      state = "CLOSED";
      for (const directory of directories) await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new WeiSQLError("INVALID_ARGUMENT", `${name} must be a positive safe integer`, { [name]: value });
  return value;
}

function numberParam(params: Readonly<Record<string, number>>, key: string, fallback: number): number {
  const value = params[key];
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new WeiSQLError("INVALID_ARGUMENT", `index.params.${key} must be a positive safe integer`, { [key]: value });
  }
  return value;
}
