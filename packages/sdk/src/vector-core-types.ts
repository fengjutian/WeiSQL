export type VectorMetric = "cosine" | "l2" | "ip";

export interface VectorCollection {
  name: string;
  count: number;
  dimension: number;
  metric: VectorMetric;
}

export interface VectorBlock {
  startRow: number;
  count: number;
  /** Row-major contiguous values; length is count × dimension. */
  values: Float32Array;
}

export interface ExactVectorHit {
  row: number;
  id: string | number;
  distance: number;
}

export interface ExactSearchOptions {
  topK: number;
  metric: VectorMetric;
  blockSize?: number;
  signal?: AbortSignal;
  /**
   * Optional restriction applied while scanning, not after Top-K.
   *
   * Filtering after Top-K would return fewer than K results even when more
   * matching rows exist, and it could not claim `exact`. The predicate is
   * evaluated per row, so a bitmap-backed implementation can be added later
   * without changing this contract.
   */
  isAllowed?: (row: number) => boolean;
}

export interface IdMapReader {
  getIds(startRow: number, count: number, options?: { signal?: AbortSignal }): Promise<readonly (string | number)[]>;
  getIdsByRows(rows: readonly number[], options?: { signal?: AbortSignal }): Promise<readonly (string | number)[]>;
  close(): Promise<void>;
}
