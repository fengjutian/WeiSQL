import type { DuckDBConnection } from "@duckdb/node-api";
import { WeiSQLError } from "@weisql/sdk";
import type { ColumnDescriptor, TableDescriptor, WeiSQLScalarType } from "@weisql/sdk";

/**
 * DuckDB type names accepted for each Manifest V1 scalar type.
 *
 * The Manifest is the contract; a Parquet file whose physical type disagrees is
 * a content defect, so the adapter rejects it instead of letting DuckDB coerce
 * silently. `json` accepts `JSON` (the extension type) and `VARCHAR`, because
 * both round-trip through the same JSON text.
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

/** L4 check: the Parquet content must expose the columns the Manifest declares. */
export async function verifyTableSchema(connection: DuckDBConnection, table: TableDescriptor): Promise<void> {
  const reader = await connection.runAndReadAll(`DESCRIBE ${quoteIdentifier(table.name)}`);
  const rows = await reader.getRowObjectsJS();
  const described: DescribedColumn[] = rows.map(row => ({
    name: String(row.column_name),
    type: String(row.column_type).toUpperCase(),
  }));

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
    throw new WeiSQLError("MANIFEST_INVALID", "Manifest declares an unsupported column type", { table: table.name, column: column.name, type: column.type });
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
