import { WeiSQLError } from "./errors.js";
import type { IdMapReader } from "./vector-core-types.js";
import type { SqlAdapter } from "./sql-adapter.js";
import type { VectorCollectionDescriptor, WeiSQLManifest } from "./types.js";
import { businessIdKey, buildIdRowIndex, compileEqualityFilter, normalizeBusinessId } from "./vector-filter.js";

/** V1 exposes one hybrid strategy; `vector-first` is specified but not implemented. */
export type HybridStrategy = "exact-filter-first";

export interface HybridFilterInput {
  manifest: Readonly<WeiSQLManifest>;
  sqlAdapter: SqlAdapter;
  idMap: IdMapReader;
  vector: VectorCollectionDescriptor;
  filter: Readonly<Record<string, string | number | boolean | null>>;
  signal?: AbortSignal;
}

export interface HybridFilterResult {
  /** Vector rows that satisfy the filter; empty when nothing matched. */
  allowedRows: Set<number>;
  strategy: HybridStrategy;
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
 * index). Both are measured in the returned diagnostics.
 */
export async function exactFilterFirst(input: HybridFilterInput): Promise<HybridFilterResult> {
  const { manifest, sqlAdapter, idMap, vector, filter, signal } = input;
  const table = manifest.tables.find(item => item.name === vector.tableName);
  if (table === undefined) {
    throw new WeiSQLError("MANIFEST_INVALID", "Vector collection references an unknown table", { collection: vector.name, table: vector.tableName });
  }
  const compiled = compileEqualityFilter(table, vector, filter);
  const rows = await sqlAdapter.query<Record<string, unknown>>(
    compiled.sql,
    compiled.parameters,
    signal === undefined ? undefined : { signal },
  );

  const allowedRows = new Set<number>();
  if (rows.length === 0) return { allowedRows, strategy: "exact-filter-first" };
  if (vector.count === 0) return { allowedRows, strategy: "exact-filter-first" };

  const index = await buildIdRowIndex(idMap, vector.count, signal === undefined ? undefined : { signal });
  for (const row of rows) {
    if (!("id" in row)) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "SQL filter projection did not return the id column", { collection: vector.name });
    }
    const id = normalizeBusinessId(row.id, table.name);
    const position = index.get(businessIdKey(id));
    if (position !== undefined) allowedRows.add(position);
  }
  return { allowedRows, strategy: "exact-filter-first" };
}
