import { WeiSQLError } from "./errors.js";
import type { IdMapReader } from "./vector-core-types.js";
import type { SQLValue, TableDescriptor, VectorCollectionDescriptor, WeiSQLScalarType } from "./types.js";

const DEFAULT_INDEX_BATCH_ROWS = 256;

/**
 * Type-aware key so the number `1` and the string `"1"` stay distinct business
 * IDs, as the Manifest allows both.
 */
export function businessIdKey(id: string | number): string {
  return `${typeof id}:${String(id)}`;
}

/**
 * Builds business ID → vector row by scanning the whole ID Map.
 *
 * V1 has no persisted reverse index, so `id → row` costs one full ID Map read.
 * That is acceptable for the exact-filter-first strategy on small packages and
 * is documented as a cost, not hidden. A future index must keep the same
 * type-aware keys.
 */
export async function buildIdRowIndex(
  idMap: IdMapReader,
  count: number,
  options?: { batchSize?: number; signal?: AbortSignal },
): Promise<Map<string, number>> {
  const batchSize = options?.batchSize ?? DEFAULT_INDEX_BATCH_ROWS;
  if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new WeiSQLError("INVALID_ARGUMENT", "batchSize must be a positive safe integer", { batchSize });
  }
  const index = new Map<string, number>();
  for (let startRow = 0; startRow < count; startRow += batchSize) {
    if (options?.signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Building the ID row index was cancelled");
    const requested = Math.min(batchSize, count - startRow);
    const ids = await idMap.getIds(startRow, requested, options === undefined ? undefined : { ...(options.signal === undefined ? {} : { signal: options.signal }) });
    for (let offset = 0; offset < ids.length; offset++) {
      const id = ids[offset]!;
      index.set(businessIdKey(id), startRow + offset);
    }
  }
  return index;
}

export interface CompiledEqualityFilter {
  sql: string;
  parameters: SQLValue[];
}

/**
 * Compiles the V1 filter object (`field → scalar`, AND semantics) into a
 * parameterised statement.
 *
 * Column identifiers come from the Manifest whitelist and are quoted; every
 * value is bound. Values are never interpolated, and a field that the Manifest
 * does not declare is rejected instead of being forwarded to the engine.
 */
export function compileEqualityFilter(
  table: TableDescriptor,
  vector: VectorCollectionDescriptor,
  filter: Readonly<Record<string, string | number | boolean | null>>,
): CompiledEqualityFilter {
  const idColumn = table.columns.find(column => column.name === vector.idColumn);
  if (idColumn === undefined) {
    throw new WeiSQLError("MANIFEST_INVALID", "Vector idColumn is not declared by its table", { table: table.name, idColumn: vector.idColumn });
  }
  const conditions: string[] = [];
  const parameters: SQLValue[] = [];
  for (const field of Object.keys(filter).sort()) {
    const column = table.columns.find(item => item.name === field);
    if (column === undefined) {
      throw new WeiSQLError("INVALID_ARGUMENT", "Filter references a column the Manifest does not declare", { table: table.name, column: field });
    }
    const value = filter[field]!;
    if (value === null) {
      conditions.push(`${quoteIdentifier(field)} IS NULL`);
      continue;
    }
    assertFilterScalar(column.type, field, value);
    conditions.push(`${quoteIdentifier(field)} = ?`);
    parameters.push(value);
  }
  const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
  return {
    sql: `SELECT ${quoteIdentifier(vector.idColumn)} AS id FROM ${quoteIdentifier(table.name)}${where}`,
    parameters,
  };
}

/**
 * Converts a SQL result value into the `string | number` business ID the ID Map
 * stores. Int64 IDs arrive as `bigint`; silently narrowing them would create
 * false matches, so an out-of-range value is an error instead.
 */
export function normalizeBusinessId(value: unknown, table: string): string | number {
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Business ID is not a safe integer", { table, id: String(value) });
    return value;
  }
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Business ID exceeds the safe integer range", { table, id: value.toString() });
    }
    return Number(value);
  }
  throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Business ID has an unsupported type", { table, type: typeof value });
}

function assertFilterScalar(type: WeiSQLScalarType, field: string, value: string | number | boolean): void {
  const accepted: Record<WeiSQLScalarType, (input: string | number | boolean) => boolean> = {
    string: input => typeof input === "string",
    int32: input => typeof input === "number" && Number.isSafeInteger(input),
    int64: input => typeof input === "number" && Number.isSafeInteger(input),
    float32: input => typeof input === "number" && Number.isFinite(input),
    float64: input => typeof input === "number" && Number.isFinite(input),
    boolean: input => typeof input === "boolean",
    // Date, timestamp and json equality are not part of the frozen V1 filter
    // object; guessing a string format here would silently produce no matches.
    timestamp: () => false,
    date: () => false,
    json: () => false,
  };
  if (!accepted[type](value)) {
    throw new WeiSQLError("INVALID_ARGUMENT", "Filter value does not match the declared column type", {
      column: field,
      columnType: type,
      valueType: typeof value,
      supported: type === "date" || type === "timestamp" || type === "json" ? "unsupported in V1" : "scalar equality",
    });
  }
}

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
