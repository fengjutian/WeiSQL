import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { DuckDBInstance, StatementType } from "@duckdb/node-api";
import type { DuckDBConnection, DuckDBPreparedStatement } from "@duckdb/node-api";
import { WeiSQLError } from "@weisql/sdk";
import type { QueryOptions, SqlAdapter, SqlAdapterCapabilities, SqlAdapterOpenContext, SQLValue } from "@weisql/sdk";

import { quoteIdentifier, verifyTableSchema } from "./schema.js";
import { normalizeRow, toDuckDbValues } from "./values.js";

export type DuckDbAdapterState = "CREATED" | "OPENING" | "READY" | "CLOSING" | "CLOSED" | "FAILED";

export interface DuckDbAdapterOptions {
  /** Refuse to materialize a table larger than this many declared bytes. */
  maxTableBytes?: number;
  /**
   * Refuse to materialize a package whose tables add up to more than this many
   * declared bytes. Checked before the DuckDB instance is created.
   */
  maxTotalTableBytes?: number;
  /** Compare the Parquet physical schema with the Manifest (L4). Defaults to true. */
  verifyTableSchema?: boolean;
  /**
   * How tables are exposed to SQL.
   *
   * - `memory` (default): copy each table into an in-memory DuckDB table and
   *   then disable external file access. Safe for untrusted SQL, but memory
   *   cost equals the table size.
   * - `lazy`: keep the extracted Parquet file and expose a view. DuckDB reads
   *   row groups on demand, so memory stays bounded, but external file access
   *   must stay enabled, which means **untrusted SQL could read arbitrary local
   *   files**. Only use it when the SQL is authored by the application.
   */
  tableLoading?: "memory" | "lazy";
  /** Additional DuckDB configuration applied when the in-memory instance is created. */
  config?: Record<string, string>;
}

const DEFAULT_MAX_TABLE_BYTES = 256 * 1024 * 1024;
/**
 * Two tables' worth. A per-table limit alone would let a ten-table package ask
 * for ten times the memory; this is still generous for Node, where the operator
 * controls the host.
 */
const DEFAULT_MAX_TOTAL_TABLE_BYTES = 512 * 1024 * 1024;
const SUPPORTED_FEATURES = [
  "select",
  "cte",
  "explain",
  "describe",
  "show",
  "summarize",
  "parameter-binding",
  "single-statement",
  "read-only-enforced",
] as const;

/**
 * Read-only DuckDB adapter for Node.js.
 *
 * Design decisions that the tests pin down:
 *
 * - Tables are materialized with `CREATE TABLE ... AS SELECT * FROM read_parquet(?)`
 *   by default. A view would need file access at query time, and
 *   `enable_external_access=false` is what stops `read_parquet('/etc/passwd')`
 *   inside user SQL, so the view route cannot be combined with that boundary.
 *   Materializing costs memory and is documented as the default trade-off.
 * - `tableLoading: "lazy"` opts into views and therefore into enabled external
 *   file access. It trades safety for bounded memory and is only appropriate when
 *   the SQL is authored by the application, not by end users.
 * - Read-only is enforced by DuckDB's own statement classification: only SELECT and
 *   EXPLAIN prepared statements run. Keyword filtering would be trivially bypassable
 *   (e.g. `WITH ... DELETE`).
 * - Multi-statement input is rejected by `prepare()`, so one call cannot smuggle a
 *   second statement.
 * - Cancellation uses `connection.interrupt()`, which is why the capability reports
 *   `native` rather than `best-effort`.
 */
export class DuckDbSqlAdapter implements SqlAdapter {
  private readonly options: Required<Pick<DuckDbAdapterOptions, "maxTableBytes" | "maxTotalTableBytes" | "verifyTableSchema" | "tableLoading">> & Pick<DuckDbAdapterOptions, "config">;
  private stateValue: DuckDbAdapterState = "CREATED";
  private instance: DuckDBInstance | undefined;
  private connection: DuckDBConnection | undefined;
  private workDirectory: string | undefined;
  private readonly retainedFiles: string[] = [];
  private capabilitiesValue: SqlAdapterCapabilities = Object.freeze({
    engine: "duckdb",
    parameterBinding: true,
    parquet: true,
    supportedFeatures: [...SUPPORTED_FEATURES],
    cancellation: "native" as const,
  });

  constructor(options: DuckDbAdapterOptions = {}) {
    const maxTableBytes = options.maxTableBytes ?? DEFAULT_MAX_TABLE_BYTES;
    if (!Number.isSafeInteger(maxTableBytes) || maxTableBytes <= 0) {
      throw new WeiSQLError("INVALID_ARGUMENT", "maxTableBytes must be a positive safe integer", { maxTableBytes });
    }
    const tableLoading = options.tableLoading ?? "memory";
    if (tableLoading !== "memory" && tableLoading !== "lazy") {
      throw new WeiSQLError("INVALID_ARGUMENT", "tableLoading must be 'memory' or 'lazy'", { tableLoading });
    }
    const maxTotalTableBytes = options.maxTotalTableBytes ?? DEFAULT_MAX_TOTAL_TABLE_BYTES;
    if (!Number.isSafeInteger(maxTotalTableBytes) || maxTotalTableBytes <= 0) {
      throw new WeiSQLError("INVALID_ARGUMENT", "maxTotalTableBytes must be a positive safe integer", { maxTotalTableBytes });
    }
    this.options = {
      maxTableBytes,
      maxTotalTableBytes,
      verifyTableSchema: options.verifyTableSchema !== false,
      tableLoading,
      ...(options.config === undefined ? {} : { config: options.config }),
    };
  }

  /** How tables are exposed: `memory` (default) or `lazy` views over extracted files. */
  get tableLoading(): "memory" | "lazy" {
    return this.options.tableLoading;
  }

  get capabilities(): Readonly<SqlAdapterCapabilities> {
    return this.capabilitiesValue;
  }

  get state(): DuckDbAdapterState {
    return this.stateValue;
  }

  async open(context: SqlAdapterOpenContext): Promise<void> {
    if (this.stateValue !== "CREATED") {
      throw new WeiSQLError("INVALID_ARGUMENT", "DuckDbSqlAdapter.open() may only be called once", { state: this.stateValue });
    }
    this.stateValue = "OPENING";
    try {
      // Reject an oversized package before creating DuckDB and a temp directory.
      this.assertTotalBudget(context.manifest.tables);
      this.instance = await DuckDBInstance.create(":memory:", this.options.config);
      this.connection = await this.instance.connect();
      this.workDirectory = await mkdtemp(path.join(tmpdir(), "weisql-duckdb-"));
      for (const table of context.manifest.tables) await this.materialize(context, table.name, table.file.path, table.file.bytes);
      if (this.options.verifyTableSchema) {
        for (const table of context.manifest.tables) await verifyTableSchema(this.connection, table);
      }
      // Lock the boundary last: it is only meaningful once every table is exposed.
      // In `lazy` mode external access must stay enabled for read_parquet, which is
      // exactly why that mode is unsafe for untrusted SQL.
      if (this.options.tableLoading === "memory") await this.connection.run("SET enable_external_access=false");
      await this.connection.run("SET lock_configuration=true");
      const version = await this.readEngineVersion(this.connection);
      this.capabilitiesValue = Object.freeze({
        engine: "duckdb",
        engineVersion: version,
        parameterBinding: true,
        parquet: true,
        supportedFeatures: [
          ...SUPPORTED_FEATURES,
          this.options.tableLoading === "memory" ? "external-access-disabled" : "external-file-access-enabled",
        ],
        cancellation: "native" as const,
      });
      this.stateValue = "READY";
    } catch (cause) {
      this.stateValue = "FAILED";
      await this.release();
      throw mapEngineError(cause, "open");
    }
  }

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    parameters: readonly SQLValue[] = [],
    options?: QueryOptions,
  ): Promise<readonly T[]> {
    const { execution, dispose } = await this.beforeQuery(statement, parameters, options);
    const signal = options?.signal;
    const maxRows = options?.maxRows;
    const connection = this.connection!;
    try {
      const interrupt = (): void => { connection.interrupt(); };
      signal?.addEventListener("abort", interrupt, { once: true });
      try {
        const result = await execution.run().catch((cause: unknown) => {
          throw mapEngineError(cause, "execute");
        });
        try {
          const rows = await result.getRowObjectsJS();
          if (maxRows !== undefined && rows.length > maxRows) {
            throw new WeiSQLError("INVALID_ARGUMENT", "Query returned more rows than maxRows", {
              maxRows,
              engine: "duckdb",
            });
          }
          return rows.map(row => normalizeRow(row as Record<string, unknown>)) as T[];
        } finally {
          result.closeSync();
        }
      } finally {
        signal?.removeEventListener("abort", interrupt);
      }
    } finally {
      dispose();
    }
  }

  /**
   * Streams rows chunk by chunk. Aborting interrupts the running query, so this
   * path is genuinely lazy: rows already yielded stay valid, and the caller can
   * stop with `break` (the async generator's `return` closes the result).
   */
  async stream<T extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    parameters: readonly SQLValue[] = [],
    options?: QueryOptions,
  ): Promise<AsyncIterable<T>> {
    const { execution, dispose } = await this.beforeQuery(statement, parameters, options);
    const signal = options?.signal;
    const maxRows = options?.maxRows;
    const connection = this.connection!;
    let result;
    try {
      result = await execution.stream().catch((cause: unknown) => {
        throw mapEngineError(cause, "execute");
      });
    } catch (cause) {
      dispose();
      throw cause;
    }
    const names = result.columnNames();
    const interrupt = (): void => { connection.interrupt(); };
    signal?.addEventListener("abort", interrupt, { once: true });
    // Race each chunk read against the signal. `interrupt()` stops the engine,
    // but without the race the caller still waits for the pending `next()` to
    // settle before it learns that it was cancelled.
    const cancelError = (): WeiSQLError =>
      new WeiSQLError("QUERY_CANCELLED", "DuckDB query was cancelled", { engine: "duckdb" });
    let abortReject: (() => void) | undefined;
    let aborted: Promise<never> | undefined;
    if (signal !== undefined) {
      aborted = new Promise<never>((_resolve, reject) => {
        abortReject = () => reject(cancelError());
      });
      const rejectOnAbort = abortReject as () => void;
      void aborted.catch(() => undefined);
      if (signal.aborted) rejectOnAbort();
      else signal.addEventListener("abort", rejectOnAbort, { once: true });
    }
    const iterator = result[Symbol.asyncIterator]();
    return (async function* (): AsyncGenerator<T> {
      let count = 0;
      try {
        for (;;) {
          const step = await (aborted === undefined ? iterator.next() : Promise.race([iterator.next(), aborted]));
          if (step.done === true) break;
          const chunk = step.value;
          const rowsInChunk = chunk.rowCount;
          for (let rowIndex = 0; rowIndex < rowsInChunk; rowIndex += 1) {
            const values = chunk.getRowValues(rowIndex);
            const raw: Record<string, unknown> = {};
            for (let column = 0; column < names.length; column += 1) raw[names[column]!] = values[column];
            count += 1;
            if (maxRows !== undefined && count > maxRows) {
              throw new WeiSQLError("INVALID_ARGUMENT", "Query returned more rows than maxRows", {
                maxRows,
                engine: "duckdb",
              });
            }
            yield normalizeRow(raw) as T;
          }
        }
      } finally {
        if (abortReject !== undefined) signal?.removeEventListener("abort", abortReject);
        result.closeSync();
        dispose();
        signal?.removeEventListener("abort", interrupt);
      }
    })();
  }

  /**
   * Shared guard for `query()` and `stream()`: validates options, applies the
   * read-only boundary to the original statement, and returns the prepared
   * statement (possibly the row-limited rewrite) with its cleanup.
   */
  private async beforeQuery(
    statement: string,
    parameters: readonly SQLValue[],
    options?: QueryOptions,
  ): Promise<{ execution: DuckDBPreparedStatement; dispose: () => void }> {
    this.ensureReady();
    if (typeof statement !== "string" || statement.trim().length === 0) {
      throw new WeiSQLError("INVALID_ARGUMENT", "SQL statement must be a non-empty string");
    }
    const signal = options?.signal;
    if (signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Query was cancelled before execution");
    const maxRows = options?.maxRows;
    if (maxRows !== undefined && (!Number.isSafeInteger(maxRows) || maxRows <= 0)) {
      throw new WeiSQLError("INVALID_ARGUMENT", "maxRows must be a positive safe integer", { maxRows });
    }
    const connection = this.connection!;

    // Fast, mode-independent rejection for obvious writes. This only stabilises
    // the error code: on a view `DELETE` fails during prepare ("can't delete from
    // a view") before the statement type is known. The authoritative boundary is
    // still the prepared statement's classification below.
    const keyword = leadingKeyword(statement);
    if (DENIED_KEYWORDS.has(keyword)) {
      throw new WeiSQLError("SQL_UNSUPPORTED", "Only read-only statements (SELECT/EXPLAIN) are allowed", {
        engine: "duckdb",
        statementType: keyword,
      });
    }

    const original = await connection.prepare(statement).catch((cause: unknown) => {
      throw mapEngineError(cause, "prepare");
    });
    let execution = original;
    let originalDestroyed = false;
    const dispose = (): void => {
      if (execution !== original) execution.destroySync();
      if (!originalDestroyed) original.destroySync();
    };
    try {
      const typeName = statementTypeName(original.statementType);
      if (original.statementType !== StatementType.SELECT && original.statementType !== StatementType.EXPLAIN) {
        throw new WeiSQLError("SQL_UNSUPPORTED", "Only read-only statements (SELECT/EXPLAIN) are allowed", {
          engine: "duckdb",
          statementType: typeName,
        });
      }
      if (original.parameterCount !== parameters.length) {
        throw new WeiSQLError("INVALID_ARGUMENT", "Parameter count does not match the statement", {
          expected: original.parameterCount,
          actual: parameters.length,
        });
      }

      if (maxRows !== undefined && original.statementType === StatementType.SELECT) {
        // Ask the engine for one row past the budget: the engine stops early, so
        // only that one extra row is ever produced.
        original.destroySync();
        originalDestroyed = true;
        execution = await connection.prepare(withRowLimit(statement, maxRows)).catch((cause: unknown) => {
          throw mapEngineError(cause, "prepare");
        });
      }
      if (execution.parameterCount !== parameters.length) {
        throw new WeiSQLError("INVALID_ARGUMENT", "Parameter count does not match the statement", {
          expected: execution.parameterCount,
          actual: parameters.length,
        });
      }
      if (parameters.length > 0) execution.bind(toDuckDbValues(parameters));
    } catch (cause) {
      dispose();
      throw cause;
    }
    return { execution, dispose };
  }


  async close(): Promise<void> {
    if (this.stateValue === "CLOSED") return;
    if (this.stateValue === "CLOSING") return;
    this.stateValue = "CLOSING";
    await this.release();
    this.stateValue = "CLOSED";
  }

  private ensureReady(): void {
    if (this.stateValue !== "READY") {
      throw new WeiSQLError("DATABASE_CLOSED", "DuckDB adapter is not ready", { state: this.stateValue });
    }
  }

  private assertTotalBudget(tables: SqlAdapterOpenContext["manifest"]["tables"]): void {
    let total = 0;
    for (const table of tables) total += table.file.bytes;
    if (total > this.options.maxTotalTableBytes) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Package exceeds the total materialization budget", {
        bytes: total,
        maxTotalTableBytes: this.options.maxTotalTableBytes,
        tables: tables.length,
      });
    }
  }

  private async materialize(context: SqlAdapterOpenContext, tableName: string, resourcePath: string, declaredBytes: number): Promise<void> {
    if (declaredBytes > this.options.maxTableBytes) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Table exceeds the materialization byte budget", {
        table: tableName,
        bytes: declaredBytes,
        maxTableBytes: this.options.maxTableBytes,
      });
    }
    const bytes = await context.reader.read(resourcePath, context.signal === undefined ? undefined : { signal: context.signal });
    if (bytes.byteLength !== declaredBytes) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Table byte length does not match the Manifest", {
        table: tableName,
        declared: declaredBytes,
        actual: bytes.byteLength,
      });
    }
    const file = path.join(this.workDirectory!, `${tableName}.parquet`);
    await writeFile(file, bytes);
    if (this.options.tableLoading === "lazy") {
      // The view is re-read on every query, so the extracted file must outlive
      // open(). It is deleted together with the work directory on close().
      // DuckDB cannot prepare a view definition that takes a parameter
      // ("Unexpected prepared parameter"), so the path is inlined as an escaped
      // literal. It comes from mkdtemp() plus a Manifest-validated identifier.
      this.retainedFiles.push(file);
      await this.connection!.run(
        `CREATE VIEW ${quoteIdentifier(tableName)} AS SELECT * FROM read_parquet('${file.replace(/'/g, "''")}')`,
      );
      return;
    }
    try {
      await this.connection!.run(
        `CREATE TABLE ${quoteIdentifier(tableName)} AS SELECT * FROM read_parquet(?)`,
        [file],
      );
    } finally {
      await unlink(file).catch(() => undefined);
    }
  }

  private async readEngineVersion(connection: DuckDBConnection): Promise<string> {
    const reader = await connection.runAndReadAll("SELECT version() AS version");
    const rows = await reader.getRowObjectsJS();
    const version = rows[0]?.version;
    return typeof version === "string" ? version : "unknown";
  }

  private async release(): Promise<void> {
    const failures: string[] = [];
    try {
      this.connection?.closeSync();
    } catch (cause) {
      failures.push(String(cause));
    }
    try {
      this.instance?.closeSync();
    } catch (cause) {
      failures.push(String(cause));
    }
    this.connection = undefined;
    this.instance = undefined;
    this.retainedFiles.length = 0;
    if (this.workDirectory !== undefined) {
      const directory = this.workDirectory;
      this.workDirectory = undefined;
      await rm(directory, { recursive: true, force: true }).catch((cause: unknown) => {
        failures.push(String(cause));
      });
    }
    if (failures.length > 0 && this.stateValue !== "FAILED") {
      throw new WeiSQLError("INTERNAL_ERROR", "DuckDB resources could not be released cleanly", { engine: "duckdb", causes: failures });
    }
  }
}

export function createDuckDbAdapter(options: DuckDbAdapterOptions = {}): DuckDbSqlAdapter {
  return new DuckDbSqlAdapter(options);
}

/**
 * Wraps a read-only statement so the engine itself stops at `maxRows + 1`.
 *
 * `maxRows` is validated as a safe positive integer before this is called, so
 * interpolating it cannot inject SQL. Trailing semicolons are stripped because a
 * subquery cannot contain them. Kept in sync with the DuckDB-Wasm adapter; the
 * SQL is portable between the two engines, which is why the shared contract can
 * assert the same behavior.
 */
function withRowLimit(statement: string, maxRows: number): string {
  const trimmed = statement.replace(/[;\s]+$/, "");
  return `SELECT * FROM (${trimmed}) AS "weisql_row_limit" LIMIT ${maxRows + 1}`;
}

function statementTypeName(type: number): string {
  for (const [name, value] of Object.entries(StatementType)) {
    if (value === type) return name;
  }
  return `UNKNOWN(${type})`;
}

const DENIED_KEYWORDS = new Set([
  "INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE",
  "CREATE", "DROP", "ALTER", "TRUNCATE",
  "COPY", "EXPORT", "IMPORT", "ATTACH", "DETACH",
  "SET", "RESET", "PRAGMA", "CALL", "LOAD", "INSTALL",
  "BEGIN", "COMMIT", "ROLLBACK", "VACUUM", "CHECKPOINT", "ANALYZE",
]);

/** First keyword after leading whitespace and SQL comments, upper-cased. */
function leadingKeyword(statement: string): string {
  let rest = statement;
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    if (rest.startsWith("--")) {
      const newline = rest.indexOf("\n");
      if (newline === -1) return "";
      rest = rest.slice(newline + 1);
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      if (end === -1) return "";
      rest = rest.slice(end + 2);
      continue;
    }
    break;
  }
  const match = /^[A-Za-z_]+/.exec(rest);
  return match === null ? "" : match[0].toUpperCase();
}

function mapEngineError(cause: unknown, phase: string): WeiSQLError {
  if (cause instanceof WeiSQLError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  const summary = message.slice(0, 300);
  if (/INTERRUPT/i.test(message)) {
    return new WeiSQLError("QUERY_CANCELLED", "DuckDB query was interrupted", { engine: "duckdb", phase, cause: summary });
  }
  if (/multiple statements/i.test(message)) {
    return new WeiSQLError("SQL_UNSUPPORTED", "Only one SQL statement per query is allowed", { engine: "duckdb", phase, cause: summary });
  }
  if (/Permission Error|cannot access file|disabled/i.test(message)) {
    return new WeiSQLError("SQL_UNSUPPORTED", "Statement is blocked by the read-only policy", { engine: "duckdb", phase, cause: summary });
  }
  if (/Parser Error|Binder Error|Catalog Error|Conversion Error|Invalid Input Error/i.test(message)) {
    return new WeiSQLError("INVALID_ARGUMENT", "DuckDB rejected the statement", { engine: "duckdb", phase, cause: summary });
  }
  return new WeiSQLError("INTERNAL_ERROR", "DuckDB execution failed", { engine: "duckdb", phase, cause: summary });
}
