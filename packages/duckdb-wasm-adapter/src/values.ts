import { WeiSQLError } from "@weisql/sdk/errors";
import type { SQLValue } from "@weisql/sdk";

const MAX_NORMALIZE_DEPTH = 8;

/** Values DuckDB-Wasm can transport through its JSON-based prepared binding. */
export type WasmParameter = string | number | boolean | null;

/**
 * Converts public `SQLValue`s into values the DuckDB-Wasm bindings accept.
 *
 * The bindings serialise parameters with `JSON.stringify` before handing them
 * to the worker, so `Date`, `Uint8Array` and out-of-range `bigint` values have
 * no faithful representation. Coercing them silently would change the meaning
 * of a query, so they are rejected with the same `INVALID_ARGUMENT` code the
 * Node adapter uses for unsupported parameter types. `bigint` values that fit
 * in a double are narrowed, because `JSON.stringify` would otherwise throw.
 */
export function toWasmParameters(values: readonly SQLValue[]): WasmParameter[] {
  return values.map((value, index) => {
    if (value === null) return null;
    switch (typeof value) {
      case "string":
      case "number":
      case "boolean":
        return value;
      case "bigint": {
        const number = Number(value);
        if (!Number.isSafeInteger(number)) {
          throw new WeiSQLError("INVALID_ARGUMENT", "SQL parameter contains a bigint outside the safe integer range", {
            parameter: index,
            engine: "duckdb-wasm",
          });
        }
        return number;
      }
      default:
        break;
    }
    if (value instanceof Date) {
      throw new WeiSQLError("INVALID_ARGUMENT", "DuckDB-Wasm cannot bind Date parameters; pass an ISO string instead", {
        parameter: index,
        engine: "duckdb-wasm",
      });
    }
    if (value instanceof Uint8Array) {
      throw new WeiSQLError("INVALID_ARGUMENT", "DuckDB-Wasm cannot bind binary parameters", {
        parameter: index,
        engine: "duckdb-wasm",
      });
    }
    throw new WeiSQLError("INVALID_ARGUMENT", "Unsupported SQL parameter type", {
      parameter: index,
      type: typeof value,
      engine: "duckdb-wasm",
    });
  });
}

/**
 * Normalises one Arrow row into the public shape.
 *
 * Arrow returns 64-bit integers as `bigint`, timestamps as `Date` and binary
 * columns as `Uint8Array`, which already matches `SQLValue`. The walk exists
 * for nested lists and structs, where Arrow hands back objects with a
 * `toJSON` helper or a non-plain prototype.
 */
export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) output[key] = normalizeValue(value, 0);
  return output;
}

export function normalizeRows(rows: readonly unknown[]): Record<string, unknown>[] {
  return rows.map(row => normalizeRow(rowAsRecord(row)));
}

function rowAsRecord(row: unknown): Record<string, unknown> {
  if (row === null || typeof row !== "object") return {};
  const maybeJson = row as { toJSON?: () => unknown };
  if (typeof maybeJson.toJSON === "function") {
    const plain = maybeJson.toJSON();
    return plain !== null && typeof plain === "object" ? (plain as Record<string, unknown>) : {};
  }
  return row as Record<string, unknown>;
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
