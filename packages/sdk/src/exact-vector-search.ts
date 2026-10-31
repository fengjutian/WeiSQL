import { WeiSQLError } from "./errors.js";
import type { VectorBlockReader } from "./vector-block-reader.js";
import { vectorDistance } from "./vector-distance.js";
import type { ExactSearchOptions, ExactVectorHit, IdMapReader } from "./vector-core-types.js";
import { TopKMaxHeap } from "./top-k-max-heap.js";

export interface ExactVectorSearchInput {
  reader: VectorBlockReader;
  idMap: IdMapReader;
  query: Float32Array;
  collectionCount: number;
  dimension: number;
  search: ExactSearchOptions;
}

/** Streaming correctness baseline. Keeps one decoded block plus at most topK hits. */
export async function exactVectorSearch(input: ExactVectorSearchInput): Promise<readonly ExactVectorHit[]> {
  const { reader, idMap, query, collectionCount, dimension, search } = input;
  const blockSize = search.blockSize ?? 1024;
  if (!Number.isSafeInteger(search.topK) || search.topK <= 0 || search.topK > 100_000 || !Number.isSafeInteger(blockSize) || blockSize <= 0 || !Number.isSafeInteger(collectionCount) || collectionCount < 0 || !Number.isSafeInteger(dimension) || dimension <= 0) {
    throw new WeiSQLError("INVALID_ARGUMENT", "Invalid exact vector search options");
  }
  if (reader.descriptor.count !== collectionCount || reader.descriptor.dimension !== dimension) {
    throw new WeiSQLError("INVALID_ARGUMENT", "Search collection metadata differs from the vector descriptor", { collectionCount, dimension });
  }
  if (query.length !== dimension) {
    throw new WeiSQLError("VECTOR_DIMENSION_MISMATCH", "Query vector dimension does not match the collection", { expected: dimension, actual: query.length });
  }
  for (let i = 0; i < query.length; i++) if (!Number.isFinite(query[i])) {
    throw new WeiSQLError("VECTOR_INVALID_VALUE", "Query vector contains a non-finite value", { dimension: i });
  }
  checkCancelled(search.signal);
  if (collectionCount === 0) return [];
  const best = new TopKMaxHeap<ExactVectorHit>(Math.min(search.topK, collectionCount));

  // Selective path: when the filter is narrow, read only the allowed rows (in
  // contiguous runs) instead of streaming every block. The 1/8 threshold keeps
  // broad filters on the sequential path, where block reads amortise better.
  const allowedRows = search.allowedRows;
  if (allowedRows !== undefined && allowedRows.size > 0 && allowedRows.size * 8 <= collectionCount) {
    const rows = [...allowedRows]
      .filter(row => Number.isSafeInteger(row) && row >= 0 && row < collectionCount)
      .sort((left, right) => left - right);
    for (const [start, end] of contiguousRuns(rows)) {
      checkCancelled(search.signal);
      const block = await reader.readBlock(start, end - start, signalOptions(search.signal));
      checkCancelled(search.signal);
      if (block.startRow !== start || block.count !== end - start || block.values.length !== block.count * dimension) {
        throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Vector block does not match the requested allowed rows", {
          expectedStart: start,
          expectedCount: end - start,
          blockStart: block.startRow,
          count: block.count,
        });
      }
      scoreBlock(block, best, query, dimension, search);
    }
  } else {
    let expectedStartRow = 0;
    while (expectedStartRow < collectionCount) {
      checkCancelled(search.signal);
      const block = await reader.readBlock(expectedStartRow, blockSize, signalOptions(search.signal));
      checkCancelled(search.signal);
      if (block.startRow !== expectedStartRow || !Number.isSafeInteger(block.count) || block.count <= 0 || block.startRow + block.count > collectionCount || block.values.length !== block.count * dimension) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Vector blocks are incomplete, overlapping or out of order", { expectedStart: expectedStartRow, blockStart: block.startRow, count: block.count });
      scoreBlock(block, best, query, dimension, search);
      expectedStartRow += block.count;
    }
    if (expectedStartRow !== collectionCount) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Vector blocks do not cover the entire collection", { expected: collectionCount, actual: expectedStartRow });
  }
  const candidates = best.toSortedArray();
  checkCancelled(search.signal);
  const ids = await idMap.getIdsByRows(candidates.map(candidate => candidate.row), signalOptions(search.signal));
  checkCancelled(search.signal);
  if (ids.length !== candidates.length) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID map count does not match the final candidates", { expected: candidates.length, actual: ids.length });
  return candidates.map((candidate, index) => {
    const id = ids[index];
    if ((typeof id !== "string" || id.length === 0) && (typeof id !== "number" || !Number.isSafeInteger(id))) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID map contains an invalid business ID", { row: candidate.row });
    return { ...candidate, id };
  });
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Vector search was cancelled");
}

/** Groups sorted rows into inclusive-exclusive runs, so neighbours share one read. */
function contiguousRuns(rows: readonly number[]): [number, number][] {
  if (rows.length === 0) return [];
  const runs: [number, number][] = [];
  let start = rows[0]!;
  let previous = start;
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index]!;
    if (row === previous + 1) {
      previous = row;
      continue;
    }
    runs.push([start, previous + 1]);
    start = row;
    previous = row;
  }
  runs.push([start, previous + 1]);
  return runs;
}

function scoreBlock(
  block: { startRow: number; count: number; values: Float32Array },
  best: TopKMaxHeap<ExactVectorHit>,
  query: Float32Array,
  dimension: number,
  search: ExactSearchOptions,
): void {
  for (let localRow = 0; localRow < block.count; localRow++) {
    checkCancelled(search.signal);
    const row = block.startRow + localRow;
    if (search.isAllowed !== undefined && !search.isAllowed(row)) continue;
    const offset = localRow * dimension;
    const distance = vectorDistance(query, block.values.subarray(offset, offset + dimension), search.metric);
    if (!Number.isFinite(distance)) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Distance calculation returned a non-finite value", { row });
    best.offer({ row, id: row, distance });
  }
}

function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } | undefined {
  return signal ? { signal } : undefined;
}
