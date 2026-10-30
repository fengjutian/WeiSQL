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
  if (!Number.isSafeInteger(search.topK) || search.topK <= 0 || search.topK > 100_000 || !Number.isSafeInteger(blockSize) || blockSize <= 0 || !Number.isSafeInteger(collectionCount) || collectionCount <= 0 || !Number.isSafeInteger(dimension) || dimension <= 0) {
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
  const best = new TopKMaxHeap<ExactVectorHit>(Math.min(search.topK, collectionCount));
  for (let startRow = 0; startRow < collectionCount; startRow += blockSize) {
    checkCancelled(search.signal);
    const block = await reader.readBlock(startRow, blockSize, signalOptions(search.signal));
    checkCancelled(search.signal);
    if (block.startRow !== startRow || block.count <= 0 || block.startRow + block.count > collectionCount || block.values.length !== block.count * dimension) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Vector block does not provide the expected contiguous rows", { expectedStart: startRow, blockStart: block.startRow, count: block.count });
    for (let localRow = 0; localRow < block.count; localRow++) {
      const offset = localRow * dimension;
      const distance = vectorDistance(query, block.values.subarray(offset, offset + dimension), search.metric);
      const row = block.startRow + localRow;
      best.offer({ row, id: row, distance });
    }
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

function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } | undefined {
  return signal ? { signal } : undefined;
}
