import { WeiSQLError } from "@weisql/sdk/errors";
import type { ColumnDescriptor, TableDescriptor, WeiSQLScalarType } from "@weisql/sdk";

import type { WasmDuckDbConnection } from "./wasm-types.js";

/**
 * DuckDB type names accepted for each Manifest V1 scalar type.
 *
 * Kept in sync with `@weisql/duckdb-adapter`: both adapters must apply the same
 * L4 rule, but the browser package cannot import the Node package (it would
 * pull in `@duckdb/node-api`). `json` accepts `JSON` and `VARCHAR` because both
 * round-trip the same JSON text.
 */
const COMPATIBLE_TYPES: Record<WeiSQLScalarType, readonly string[]> = {
  string: ["VARCHAR"],
  int32: ["INTEGER"],
  int64: ["BIGINT"],
  float32: ["FLOAT"],
  float64: ["DOUBLE"],
  boolean: ["BOOLEAN"],
  timestamp: ["TIMESTAMP", "TIMESTAMP_S", "TIMESTAMP_MS", "TIMESTAMP_NS"],
  date: ["DATE"],
  json: ["JSON", "VARCHAR"],
};

interface DescribedColumn {
  name: string;
  type: string;
}

/** L4 check: the materialized table must expose the columns the Manifest declares. */
export async function verifyTableSchema(connection: WasmDuckDbConnection, table: TableDescriptor): Promise<void> {
  const result = await connection.query(`DESCRIBE ${quoteIdentifier(table.name)}`);
  const described: DescribedColumn[] = result.toArray().map((entry: unknown) => {
    const row = entry as { column_name?: unknown; column_type?: unknown };
    return { name: String(row.column_name), type: String(row.column_type).toUpperCase() };
  });

  for (const column of table.columns) {
    const actual = described.find(item => item.name === column.name);
    if (actual === undefined) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Parquet content is missing a declared column", {
        table: table.name,
        column: column.name,
        available: described.map(item => item.name),
      });
    }
    assertCompatibleType(table, column, actual);
  }
}

function assertCompatibleType(table: TableDescriptor, column: ColumnDescriptor, actual: DescribedColumn): void {
  const accepted = COMPATIBLE_TYPES[column.type];
  if (accepted === undefined) {
    throw new WeiSQLError("MANIFEST_INVALID", "Manifest declares an unsupported column type", {
      table: table.name,
      column: column.name,
      type: column.type,
    });
  }
  const normalized = actual.type.replace(/\(.*\)$/, "");
  if (!accepted.includes(normalized)) {
    throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Parquet column type does not match the Manifest", {
      table: table.name,
      column: column.name,
      declared: column.type,
      expected: accepted,
      actual: actual.type,
    });
  }
}

/** Manifest table names are validated identifiers, but quoting keeps the SQL boundary explicit. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
