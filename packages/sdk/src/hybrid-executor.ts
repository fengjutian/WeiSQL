import { WeiSQLError } from "./errors.js";
import type { IdMapReader } from "./vector-core-types.js";
import type { SqlAdapter } from "./sql-adapter.js";
import type { FilterExpression, HybridStrategy, VectorCollectionDescriptor, WeiSQLManifest } from "./types.js";
import type { ResourceReader } from "./resource-reader.js";
import { businessIdKey, buildIdRowIndex, compileFilter, normalizeBusinessId } from "./vector-filter.js";
import type { SortedIdIndexReader } from "./sorted-id-index.js";

export type { FilterExpression } from "./types.js";

interface FilterQueryInput {
  manifest: Readonly<WeiSQLManifest>;
  sqlAdapter: SqlAdapter;
  vector: VectorCollectionDescriptor;
  filter: FilterExpression;
  signal?: AbortSignal;
}

export interface HybridFilterInput extends FilterQueryInput {
  idMap: IdMapReader;
  /**
   * Cached sorted index owned by the Runtime. When absent, the filter falls back
   * to one full ID Map scan.
   */
  idIndex?: SortedIdIndexReader;
}

export interface HybridFilterResult {
  /** Vector rows that satisfy the filter; empty when nothing matched. */
  allowedRows: Set<number>;
  strategy: "exact-filter-first";
}

/**
 * `exact-filter-first`: resolve the complete matching ID set in SQL, map it back
 * to vector rows, then let the exact scan consider only those rows.
 *
 * This is deliberately not "vector-first". Taking the unfiltered Top-K and
 * dropping non-matching hits afterwards would return fewer than K results even
 * when enough matches exist, and it could not claim `exact`.
 *
 * Cost: one SQL query plus one full ID Map scan (V1 has no persisted ID → row
 * index).
 */
export async function exactFilterFirst(input: HybridFilterInput): Promise<HybridFilterResult> {
  const { idMap, vector, signal } = input;
  const ids = await queryFilteredIds(input);
  const allowedRows = new Set<number>();
  if (ids.length === 0 || vector.count === 0) return { allowedRows, strategy: "exact-filter-first" };

  // A sorted id index turns each lookup into a binary search; for large ID sets
  // one sequential scan still wins, because it is a single pass over the file.
  const idIndex = input.idIndex;
  if (vector.idIndex !== undefined && idIndex !== undefined) {
    for (const row of await idIndex.rowsOf(ids, signal)) allowedRows.add(row);
    return { allowedRows, strategy: "exact-filter-first" };
  }

  const index = await buildIdRowIndex(idMap, vector.count, signal === undefined ? undefined : { signal });
  for (const id of ids) {
    const position = index.get(businessIdKey(id));
    if (position !== undefined) allowedRows.add(position);
  }
  return { allowedRows, strategy: "exact-filter-first" };
}

export interface VectorFirstInput extends FilterQueryInput {
  /** Exact-scan candidates ordered by distance (best first). */
  candidates: readonly { id: string | number }[];
  topK: number;
  initialCandidates?: number;
  expansionStep?: number;
  maxCandidates?: number;
}

export interface VectorFirstResult {
  /** Indexes into `candidates` that were accepted, in distance order. */
  matchedIndexes: number[];
  strategy: "vector-first";
  /** Candidate window that produced the accepted results. */
  candidatesScanned: number;
  /** Candidates inside that window which satisfied the filter. */
  filteredCandidates: number;
  candidateCap: number;
  /**
   * `true` only when the window covered the whole collection, which makes the
   * result exact by exhaustion rather than by construction.
   */
  exact: boolean;
}

/**
 * `vector-first`: take a bounded candidate window, then keep the candidates the
 * SQL filter accepts.
 *
 * Limiting the window before filtering means the result is the nearest K *among
 * the candidates considered*, not necessarily the nearest K of the filtered set,
 * so it can only be called `exact` when the window reached the collection size.
 * The window grows by `expansionStep` until it yields `topK` matches or the cap
 * is reached; the caller reports the window actually used.
 *
 * Cost trade-off: business IDs are read only for the candidate window, so this
 * avoids the full ID Map scan that `exact-filter-first` pays. The vector scan is
 * still a full pass, because V1 has no ANN index.
 */
export async function vectorFirst(input: VectorFirstInput): Promise<VectorFirstResult> {
  const { vector, candidates, topK, initialCandidates, expansionStep, maxCandidates, signal } = input;
  const cap = candidateCapFor(maxCandidates, topK, vector.count);
  const step = positiveInteger(expansionStep ?? Math.max(topK * 4, 1), "expansionStep");
  const start = Math.min(Math.max(positiveInteger(initialCandidates ?? Math.max(topK * 4, 1), "initialCandidates"), topK), cap);

  const ids = await queryFilteredIds(input);
  const allowed = new Set(ids.map(businessIdKey));
  const matchedIndexes: number[] = [];
  for (let index = 0; index < candidates.length; index++) {
    if (allowed.has(businessIdKey(candidates[index]!.id))) matchedIndexes.push(index);
  }

  const matchesWithin = (window: number): number => matchedIndexes.filter(index => index < window).length;
  let candidatesScanned = Math.min(start, candidates.length);
  let filteredCandidates = matchesWithin(candidatesScanned);
  while (filteredCandidates < topK && candidatesScanned < cap && candidatesScanned < candidates.length) {
    candidatesScanned = Math.min(candidatesScanned + step, cap, candidates.length);
    filteredCandidates = matchesWithin(candidatesScanned);
  }

  return {
    matchedIndexes: matchedIndexes.slice(0, topK),
    strategy: "vector-first",
    candidatesScanned,
    filteredCandidates,
    candidateCap: cap,
    exact: candidatesScanned >= vector.count,
  };
}

/** Shared SQL step: the complete set of business IDs that satisfy the filter. */
async function queryFilteredIds(input: FilterQueryInput): Promise<(string | number)[]> {
  const { manifest, sqlAdapter, vector, filter, signal } = input;
  const table = manifest.tables.find(item => item.name === vector.tableName);
  if (table === undefined) {
    throw new WeiSQLError("MANIFEST_INVALID", "Vector collection references an unknown table", { collection: vector.name, table: vector.tableName });
  }
  const compiled = compileFilter(table, vector, filter);
  const rows = await sqlAdapter.query<Record<string, unknown>>(
    compiled.sql,
    compiled.parameters,
    signal === undefined ? undefined : { signal },
  );
  const ids: (string | number)[] = [];
  for (const row of rows) {
    if (!("id" in row)) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "SQL filter projection did not return the id column", { collection: vector.name });
    }
    ids.push(normalizeBusinessId(row.id, table.name));
  }
  return ids;
}

export function candidateCapFor(maxCandidates: number | undefined, topK: number, count: number): number {
  const cap = maxCandidates ?? 10_000;
  if (!Number.isSafeInteger(cap) || cap <= 0) throw new WeiSQLError("INVALID_ARGUMENT", "maxCandidates must be a positive safe integer", { maxCandidates: cap });
  if (cap < topK) throw new WeiSQLError("INVALID_ARGUMENT", "maxCandidates must be at least topK", { maxCandidates: cap, topK });
  return Math.min(cap, Math.max(count, topK));
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new WeiSQLError("INVALID_ARGUMENT", `${name} must be a positive safe integer`, { [name]: value });
  return value;
}
