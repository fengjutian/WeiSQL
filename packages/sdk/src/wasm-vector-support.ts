import { WeiSQLError } from "./errors.js";
import { IndexedIdMapReader } from "./indexed-id-map-reader.js";
import type { ResourceReader } from "./resource-reader.js";
import type { VectorCollectionDescriptor } from "./types.js";
import { VectorBlockReader } from "./vector-block-reader.js";

/**
 * Helpers shared by the WASM-backed vector adapters. Both engines need the same
 * collection materialisation, busines-ID resolution and cancellation checks;
 * keeping one copy avoids the two adapters drifting apart.
 */

/** Reads the whole collection into one row-major `Float32Array`. */
export async function materializeVectors(
  source: ResourceReader,
  vector: VectorCollectionDescriptor,
  blockSize: number,
  signal: AbortSignal | undefined,
): Promise<Float32Array> {
  const { count, dimension, data } = vector;
  const reader = new VectorBlockReader(source, { path: data.path, count, dimension, bytes: data.bytes });
  const values = new Float32Array(count * dimension);
  let written = 0;
  for (let start = 0; start < count; start += blockSize) {
    throwIfAborted(signal);
    const block = await reader.readBlock(
      start,
      Math.min(blockSize, count - start),
      signal === undefined ? undefined : { signal },
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

/** Resolves row numbers to validated business IDs through the indexed ID map. */
export async function readBusinessIds(
  source: ResourceReader,
  vector: VectorCollectionDescriptor,
  rows: readonly number[],
  signal: AbortSignal | undefined,
): Promise<readonly (string | number)[]> {
  if (rows.length === 0) return [];
  const idMap = new IndexedIdMapReader(source, {
    dataPath: vector.idMap.data.path,
    offsetsPath: vector.idMap.offsets.path,
    count: vector.idMap.count,
    dataBytes: vector.idMap.data.bytes,
    offsetsBytes: vector.idMap.offsets.bytes,
  });
  try {
    const ids = await idMap.getIdsByRows(rows, signal === undefined ? undefined : { signal });
    if (ids.length !== rows.length) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID map count does not match the final candidates", {
        expected: rows.length,
        actual: ids.length,
      });
    }
    return ids;
  } finally {
    await idMap.close();
  }
}

/** Throws before dereferencing `id` when the ID map returned something invalid. */
export function assertBusinessId(id: string | number | undefined, row: number): string | number {
  if ((typeof id !== "string" || id.length === 0) && (typeof id !== "number" || !Number.isSafeInteger(id))) {
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID map contains an invalid business ID", { row });
  }
  return id;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Vector search was cancelled");
}
