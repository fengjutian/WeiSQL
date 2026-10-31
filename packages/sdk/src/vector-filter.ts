import { WeiSQLError } from "./errors.js";
import type { IdMapReader } from "./vector-core-types.js";
import type { FilterExpression, FilterScalar, SQLValue, TableDescriptor, VectorCollectionDescriptor, WeiSQLScalarType } from "./types.js";

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
 * Compiles a filter expression into a parameterised statement.
 *
 * Column identifiers come from the Manifest whitelist and are quoted; every value
 * is bound. Fields the Manifest does not declare are rejected instead of being
 * forwarded to the engine, and values are checked against the declared column
 * type before they reach SQL.
 */
export function compileFilter(
  table: TableDescriptor,
  vector: VectorCollectionDescriptor,
  filter: FilterExpression,
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
    const quoted = quoteIdentifier(field);
    const condition = filter[field]!;

    if (condition instanceof Date) {
      conditions.push(`${quoted} = ?`);
      parameters.push(normalizeFilterValue(column.type, field, condition));
      continue;
    }
    if (Array.isArray(condition)) {
      appendIn(quoted, column.type, field, condition, conditions, parameters);
      continue;
    }
    if (typeof condition === "object" && condition !== null) {
      const keys = Object.keys(condition);
      if (keys.includes("in")) {
        if (keys.length !== 1) throw new WeiSQLError("INVALID_ARGUMENT", "A filter condition cannot mix 'in' with other operators", { column: field });
        appendIn(quoted, column.type, field, (condition as { in: readonly FilterScalar[] }).in, conditions, parameters);
        continue;
      }
      if (keys.includes("ne")) {
        if (keys.length !== 1) throw new WeiSQLError("INVALID_ARGUMENT", "A filter condition cannot mix 'ne' with other operators", { column: field });
        const value = (condition as { ne: FilterScalar }).ne;
        if (value === null) throw new WeiSQLError("INVALID_ARGUMENT", "'ne' does not accept null", { column: field });
        conditions.push(`${quoted} <> ?`);
        parameters.push(normalizeFilterValue(column.type, field, value));
        continue;
      }
      appendRange(quoted, column.type, field, condition as Record<string, FilterScalar | undefined>, conditions, parameters);
      continue;
    }
    if (condition === null) {
      conditions.push(`${quoted} IS NULL`);
      continue;
    }
    conditions.push(`${quoted} = ?`);
    parameters.push(normalizeFilterValue(column.type, field, condition));
  }
  const where = conditions.length === 0 ? "" : ` WHERE ${conditions.join(" AND ")}`;
  return {
    sql: `SELECT ${quoteIdentifier(vector.idColumn)} AS id FROM ${quoteIdentifier(table.name)}${where}`,
    parameters,
  };
}

/** Backwards-compatible name for the original equality-only entry point. */
export function compileEqualityFilter(
  table: TableDescriptor,
  vector: VectorCollectionDescriptor,
  filter: FilterExpression,
): CompiledEqualityFilter {
  return compileFilter(table, vector, filter);
}

function appendIn(
  quoted: string,
  type: WeiSQLScalarType,
  field: string,
  values: readonly FilterScalar[],
  conditions: string[],
  parameters: SQLValue[],
): void {
  if (!Array.isArray(values) || values.length === 0) {
    throw new WeiSQLError("INVALID_ARGUMENT", "A membership condition needs at least one value", { column: field });
  }
  if (values.length > 1000) {
    throw new WeiSQLError("INVALID_ARGUMENT", "A membership condition is limited to 1000 values", { column: field, count: values.length });
  }
  for (const value of values) {
    if (value === null) throw new WeiSQLError("INVALID_ARGUMENT", "Membership conditions do not accept null; use IS NULL separately", { column: field });
    parameters.push(normalizeFilterValue(type, field, value));
  }
  conditions.push(`${quoted} IN (${values.map(() => "?").join(", ")})`);
}

function appendRange(
  quoted: string,
  type: WeiSQLScalarType,
  field: string,
  range: Record<string, FilterScalar | undefined>,
  conditions: string[],
  parameters: SQLValue[],
): void {
  const allowedKeys = new Set(["gte", "gt", "lte", "lt"]);
  const keys = Object.keys(range);
  for (const key of keys) {
    if (!allowedKeys.has(key)) throw new WeiSQLError("INVALID_ARGUMENT", "Range conditions only accept gte/gt/lte/lt", { column: field, operator: key });
  }
  if (keys.length === 0) throw new WeiSQLError("INVALID_ARGUMENT", "A range condition needs at least one bound", { column: field });
  if (range.gte !== undefined && range.gt !== undefined) {
    throw new WeiSQLError("INVALID_ARGUMENT", "A range condition cannot combine 'gte' and 'gt'", { column: field });
  }
  if (range.lte !== undefined && range.lt !== undefined) {
    throw new WeiSQLError("INVALID_ARGUMENT", "A range condition cannot combine 'lte' and 'lt'", { column: field });
  }
  const operators: [string, string, FilterScalar | undefined][] = [["gt", ">", range.gt], ["gte", ">=", range.gte], ["lt", "<", range.lt], ["lte", "<=", range.lte]];
  for (const [name, sqlOperator, value] of operators) {
    if (value === undefined) continue;
    if (value === null) throw new WeiSQLError("INVALID_ARGUMENT", "Range bounds must not be null", { column: field, operator: name });
    conditions.push(`${quoted} ${sqlOperator} ?`);
    parameters.push(normalizeFilterValue(type, field, value));
  }
}

/** Validates one value against the declared column type and converts it for SQL. */
function normalizeFilterValue(type: WeiSQLScalarType, field: string, value: FilterScalar): SQLValue {
  if (value === null) throw new WeiSQLError("INVALID_ARGUMENT", "Filter values must not be null here", { column: field });
  if (value instanceof Date) {
    if (type !== "date" && type !== "timestamp") {
      throw new WeiSQLError("INVALID_ARGUMENT", "Date values are only valid for date or timestamp columns", { column: field, columnType: type });
    }
    if (Number.isNaN(value.getTime())) throw new WeiSQLError("INVALID_ARGUMENT", "Filter Date is invalid", { column: field });
    return type === "date" ? value.toISOString().slice(0, 10) : value.toISOString();
  }
  const accepted: Record<WeiSQLScalarType, boolean> = {
    string: typeof value === "string",
    int32: typeof value === "number" && Number.isSafeInteger(value),
    int64: typeof value === "number" && Number.isSafeInteger(value),
    float32: typeof value === "number" && Number.isFinite(value),
    float64: typeof value === "number" && Number.isFinite(value),
    boolean: typeof value === "boolean",
    timestamp: typeof value === "string" && !Number.isNaN(Date.parse(value)),
    date: typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value)),
    json: false,
  };
  if (!accepted[type]) {
    throw new WeiSQLError("INVALID_ARGUMENT", "Filter value does not match the declared column type", {
      column: field,
      columnType: type,
      valueType: typeof value,
      supported: type === "json" ? "unsupported (JSON equality needs a canonical form)" : "scalar, membership or range",
    });
  }
  return value as SQLValue;
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

function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
