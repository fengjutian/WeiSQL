import { blobValue, timestampValue } from "@duckdb/node-api";
import type { DuckDBValue } from "@duckdb/node-api";
import { WeiSQLError } from "@weisql/sdk";
import type { SQLValue } from "@weisql/sdk";

const MAX_NORMALIZE_DEPTH = 8;

/**
 * Translates public `SQLValue`s into DuckDB values.
 *
 * Only the documented V1 scalar types are accepted; anything else is rejected
 * instead of being coerced, because DuckDB would otherwise accept an object and
 * silently interpret it in an engine-specific way.
 */
export function toDuckDbValues(values: readonly SQLValue[]): DuckDBValue[] {
  return values.map((value, index) => {
    if (value === null) return null;
    switch (typeof value) {
      case "string":
      case "number":
      case "boolean":
      case "bigint":
        return value;
      default:
        break;
    }
    if (value instanceof Date) {
      const millis = value.getTime();
      if (!Number.isFinite(millis)) throw new WeiSQLError("INVALID_ARGUMENT", "SQL parameter contains an invalid Date", { parameter: index });
      return timestampValue(BigInt(millis) * 1000n);
    }
    if (value instanceof Uint8Array) return blobValue(value);
    throw new WeiSQLError("INVALID_ARGUMENT", "Unsupported SQL parameter type", { parameter: index, type: typeof value });
  });
}

/**
 * Converts DuckDB JavaScript rows into plain values.
 *
 * DuckDB returns BLOBs as Node.js `Buffer`s; the public contract promises
 * `Uint8Array`, and a `Buffer` would leak a Node-only type into browser-shaped
 * results. Nested lists and structs are walked so the guarantee holds inside
 * them too. DECIMAL values arrive as `number`, which is documented as a
 * precision limitation for more than 15 significant digits.
 */
export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) output[key] = normalizeValue(value, 0);
  return output;
}

function normalizeValue(value: unknown, depth: number): unknown {
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value === null || value === undefined) return value ?? null;
  if (depth >= MAX_NORMALIZE_DEPTH) return value;
  if (Array.isArray(value)) return value.map(item => normalizeValue(item, depth + 1));
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) output[key] = normalizeValue(item, depth + 1);
      return output;
    }
  }
  return value;
}
