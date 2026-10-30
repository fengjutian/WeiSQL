import { WeiSQLError } from "./errors.js";
import type { VectorMetric } from "./vector-core-types.js";

/** All metrics return a finite distance where smaller means more similar. */
export function vectorDistance(a: Float32Array, b: Float32Array, metric: VectorMetric): number {
  if (a.length === 0 || a.length !== b.length) {
    throw new WeiSQLError("VECTOR_DIMENSION_MISMATCH", "Vector dimensions must be non-zero and equal", { left: a.length, right: b.length });
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  let squaredDistance = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new WeiSQLError("VECTOR_INVALID_VALUE", "Vectors must contain only finite values", { dimension: i });
    }
    dot += x * y;
    normA += x * x;
    normB += y * y;
    const diff = x - y;
    squaredDistance += diff * diff;
  }
  switch (metric) {
    case "cosine": {
      if (normA === 0 || normB === 0) throw new WeiSQLError("VECTOR_INVALID_VALUE", "Cosine distance is undefined for zero vectors");
      const similarity = dot / Math.sqrt(normA * normB);
      return 1 - Math.max(-1, Math.min(1, similarity));
    }
    case "l2": return Math.sqrt(squaredDistance);
    case "ip": return -dot;
  }
}
