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
}

export interface IdMapReader {
  getIds(startRow: number, count: number, options?: { signal?: AbortSignal }): Promise<readonly (string | number)[]>;
  close(): Promise<void>;
}
