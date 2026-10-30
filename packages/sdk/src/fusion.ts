/**
 * Reciprocal Rank Fusion (RRF) for combining rankings from different sources.
 *
 * Why RRF instead of normalising scores: BM25 scores are unbounded and
 * dataset-dependent, vector distances live in metric-specific ranges (cosine in
 * [0, 2], L2 unbounded, IP unbounded), so any score-level normalisation would be
 * arbitrary. RRF only uses ranks, which makes the combination comparable and
 * stable across queries.
 *
 * `score(d) = Σ 1 / (k + rank_i(d))`, with ranks starting at 1.
 */
import { businessIdKey } from "./vector-filter.js";

export interface Ranking {
  /** Source name, used as the key in `ranks`. */
  name: string;
  /** Business IDs in rank order, best first. */
  ids: readonly (string | number)[];
}

export interface FusedHit {
  id: string | number;
  /** Fused RRF score; higher is better. */
  score: number;
  /** 1-based rank in each source that returned this document. */
  ranks: Readonly<Record<string, number>>;
}

export interface FusionOptions {
  /** RRF constant; defaults to 60. Must be positive. */
  k?: number;
  /** Maximum number of fused hits to return; defaults to 10. */
  topK?: number;
}

/**
 * Fuses rankings by business ID.
 *
 * Ties are broken by the best individual rank (a document ranked 1st in one
 * source outranks one ranked 2nd everywhere), then by `row`-independent
 * insertion order so the result is deterministic.
 */
export function reciprocalRankFusion(rankings: readonly Ranking[], options: FusionOptions = {}): FusedHit[] {
  const k = options.k ?? 60;
  const topK = options.topK ?? 10;
  if (!Number.isSafeInteger(topK) || topK <= 0) throw new Error("topK must be a positive integer");
  if (!(k > 0) || !Number.isFinite(k)) throw new Error("k must be a positive finite number");

  const fused = new Map<string, { id: string | number; score: number; ranks: Record<string, number>; bestRank: number; order: number }>();
  let order = 0;

  for (const ranking of rankings) {
    ranking.ids.forEach((id, index) => {
      const key = businessIdKey(id);
      const rank = index + 1;
      const contribution = 1 / (k + rank);
      const existing = fused.get(key);
      if (existing === undefined) {
        fused.set(key, { id, score: contribution, ranks: { [ranking.name]: rank }, bestRank: rank, order: order++ });
        return;
      }
      existing.score += contribution;
      existing.ranks[ranking.name] = rank;
      existing.bestRank = Math.min(existing.bestRank, rank);
    });
  }

  return [...fused.values()]
    .sort((left, right) => right.score - left.score || left.bestRank - right.bestRank || left.order - right.order)
    .slice(0, topK)
    .map(entry => ({ id: entry.id, score: entry.score, ranks: entry.ranks }));
}
