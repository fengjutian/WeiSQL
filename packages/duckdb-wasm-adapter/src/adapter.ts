import { WeiSQLError } from "@weisql/sdk/errors";
import type { QueryOptions, SqlAdapter, SqlAdapterCapabilities, SqlAdapterOpenContext, SQLValue } from "@weisql/sdk";

import { quoteIdentifier, verifyTableSchema } from "./schema.js";
import { assertReadOnlyStatement } from "./sql-guard.js";
import type { SqlTokenStream } from "./sql-guard.js";
import { normalizeRows, toWasmParameters } from "./values.js";
import type { WasmDuckDb, WasmDuckDbConnection } from "./wasm-types.js";

export type DuckDbWasmAdapterState = "CREATED" | "OPENING" | "READY" | "CLOSING" | "CLOSED" | "FAILED";

/** Where the browser can fetch the DuckDB-Wasm module and its worker. */
export interface DuckDbWasmBundleUrls {
  mainModule: string;
  mainWorker: string;
  pthreadWorker?: string | null;
}

export interface DuckDbWasmAdapterOptions {
  /**
   * URLs of the WASM module and worker script. Required unless `database` is
   * injected: the adapter does not guess a CDN, because a static deployment
   * must control what it downloads.
   */
  bundles?: DuckDbWasmBundleUrls;
  /**
   * Pre-built database instance. This is the seam used by tests (and by
   * applications that already own an `AsyncDuckDB`); when present the adapter
   * does not create or terminate the instance.
   */
  database?: WasmDuckDb;
  /** Refuse to materialize a table larger than this many declared bytes. */
  maxTableBytes?: number;
  /** Compare the materialized schema with the Manifest (L4). Defaults to true. */
  verifyTableSchema?: boolean;
  /**
   * Base URL of a self-hosted DuckDB extension repository. When omitted,
   * DuckDB-Wasm downloads `parquet` from `extensions.duckdb.org`.
   */
  extensionRepository?: string;
  /** Forward DuckDB-Wasm logs to the console. Defaults to silent. */
  logger?: "silent" | "console";
}

const DEFAULT_MAX_TABLE_BYTES = 256 * 1024 * 1024;
const SUPPORTED_FEATURES = [
  "select",
  "explain",
  "describe",
  "show",
  "summarize",
  "parameter-binding",
  "single-statement",
  "read-only-keyword-enforced",
  "external-access-disabled",
] as const;

/**
 * Read-only DuckDB-Wasm adapter for browsers.
 *
 * Design decisions, and why they differ from the Node adapter:
 *
 * - Tables are materialized from Parquet bytes that the SDK's `ResourceReader`
 *   already fetched and (optionally) verified. DuckDB-Wasm never fetches the
 *   package itself, so `HttpResourceReader`'s Range behaviour, cache and L3
 *   checks stay the single data path.
 * - The `parquet` extension is loaded explicitly, so a missing extension fails
 *   `open()` with a clear error instead of surfacing on the first query. It is
 *   the one network dependency of the browser path and is documented as such.
 * - Read-only is enforced with an allow-list of leading keywords. DuckDB-Wasm
 *   does not expose the prepared statement's `StatementType`, so the Node
 *   adapter's engine-level classification is not available; `WITH` is rejected
 *   because it would otherwise be the obvious bypass.
 * - Parameters are bound through the prepared statement, but the bindings
 *   serialise them as JSON, so only strings, numbers, booleans and `null` are
 *   accepted. Values without a faithful JSON representation are rejected.
 */
export class DuckDbWasmSqlAdapter implements SqlAdapter {
  private readonly options: {
    bundles?: DuckDbWasmBundleUrls;
    database?: WasmDuckDb;
    maxTableBytes: number;
    verifyTableSchema: boolean;
    extensionRepository?: string;
    logger: "silent" | "console";
  };
  private stateValue: DuckDbWasmAdapterState = "CREATED";
  private database: WasmDuckDb | undefined;
  private connection: WasmDuckDbConnection | undefined;
  private ownsDatabase = false;
  private tokenizerAvailable = false;
  private capabilitiesValue: SqlAdapterCapabilities = Object.freeze({
    engine: "duckdb-wasm",
    parameterBinding: true,
    parquet: true,
    supportedFeatures: [...SUPPORTED_FEATURES],
    cancellation: "best-effort" as const,
  });

  constructor(options: DuckDbWasmAdapterOptions = {}) {
    const maxTableBytes = options.maxTableBytes ?? DEFAULT_MAX_TABLE_BYTES;
    if (!Number.isSafeInteger(maxTableBytes) || maxTableBytes <= 0) {
      throw new WeiSQLError("INVALID_ARGUMENT", "maxTableBytes must be a positive safe integer", { maxTableBytes });
    }
    if (options.bundles === undefined && options.database === undefined) {
      throw new WeiSQLError("INVALID_ARGUMENT", "DuckDbWasmSqlAdapter requires either bundles or a database instance");
    }
    if (options.extensionRepository !== undefined) assertHttpUrl(options.extensionRepository, "extensionRepository");
    this.options = {
      maxTableBytes,
      verifyTableSchema: options.verifyTableSchema !== false,
      logger: options.logger ?? "silent",
      ...(options.bundles === undefined ? {} : { bundles: options.bundles }),
      ...(options.database === undefined ? {} : { database: options.database }),
      ...(options.extensionRepository === undefined ? {} : { extensionRepository: options.extensionRepository }),
    };
  }

  get capabilities(): Readonly<SqlAdapterCapabilities> {
    return this.capabilitiesValue;
  }

  get state(): DuckDbWasmAdapterState {
    return this.stateValue;
  }

  async open(context: SqlAdapterOpenContext): Promise<void> {
    if (this.stateValue !== "CREATED") {
      throw new WeiSQLError("INVALID_ARGUMENT", "DuckDbWasmSqlAdapter.open() may only be called once", { state: this.stateValue });
    }
    this.stateValue = "OPENING";
    try {
      await this.instantiate();
      this.connection = await this.database!.connect();
      await this.loadParquetExtension();
      for (const [index, table] of context.manifest.tables.entries()) {
        await this.materialize(context, index, table.name, table.file.path, table.file.bytes);
      }
      if (this.options.verifyTableSchema) {
        for (const table of context.manifest.tables) await verifyTableSchema(this.connection, table);
      }
      // Lock the boundary last, after the extension and every table are in place.
      await this.connection.query("SET enable_external_access=false");
      await this.connection.query("SET lock_configuration=true");
      const version = await this.readEngineVersion();
      this.capabilitiesValue = Object.freeze({
        engine: "duckdb-wasm",
        engineVersion: version,
        parameterBinding: true,
        parquet: true,
        supportedFeatures: [
          ...SUPPORTED_FEATURES,
          ...(this.tokenizerAvailable ? ["cte"] : []),
        ],
        cancellation: "best-effort" as const,
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
    this.ensureReady();
    const signal = options?.signal;
    if (signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Query was cancelled before execution");
    const tokens = await this.tokenizeForGuard(statement);
    assertReadOnlyStatement(statement, tokens);
    const connection = this.connection!;
    const prepared = await connection.prepare(statement).catch((cause: unknown) => {
      throw mapEngineError(cause, "prepare");
    });
    try {
      const values = toWasmParameters(parameters);
      const interrupt = (): void => {
        // DuckDB-Wasm can only ask the engine to cancel; the worker may still
        // finish the current task, which is why the capability is best-effort.
        void Promise.resolve(connection.cancelSent?.()).catch(() => undefined);
      };
      signal?.addEventListener("abort", interrupt, { once: true });
      try {
        const table = await prepared.query(...values).catch((cause: unknown) => {
          throw mapEngineError(cause, "execute");
        });
        return normalizeRows(table.toArray()) as T[];
      } catch (cause) {
        if (signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "DuckDB-Wasm query was cancelled", { engine: "duckdb-wasm" });
        throw cause;
      } finally {
        signal?.removeEventListener("abort", interrupt);
      }
    } finally {
      await Promise.resolve(prepared.close?.()).catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    if (this.stateValue === "CLOSED" || this.stateValue === "CLOSING") return;
    this.stateValue = "CLOSING";
    await this.release();
    this.stateValue = "CLOSED";
  }

  private ensureReady(): void {
    if (this.stateValue !== "READY") {
      throw new WeiSQLError("DATABASE_CLOSED", "DuckDB-Wasm adapter is not ready", { state: this.stateValue });
    }
  }

  private async instantiate(): Promise<void> {
    if (this.options.database !== undefined) {
      this.database = this.options.database;
      this.ownsDatabase = false;
      this.tokenizerAvailable = typeof this.database.tokenize === "function";
      return;
    }
    const bundles = this.options.bundles!;
    const duckdb = await import("@duckdb/duckdb-wasm");
    const logger = this.options.logger === "console" ? new duckdb.ConsoleLogger() : new duckdb.VoidLogger();
    const worker = new Worker(bundles.mainWorker);
    const database = new duckdb.AsyncDuckDB(logger, worker);
    await database.instantiate(bundles.mainModule, bundles.pthreadWorker ?? null);
    // Arrow hands DECIMAL back as a typed-array of unscaled words, which is not
    // a public `SQLValue`. The Node adapter's driver already reports DECIMAL as
    // `number`; asking DuckDB to cast it to DOUBLE keeps the two engines aligned
    // and documents the same >15-significant-digit limitation.
    await database.open({ path: ":memory:", query: { castDecimalToDouble: true } });
    this.database = database as unknown as WasmDuckDb;
    this.ownsDatabase = true;
    this.tokenizerAvailable = typeof this.database.tokenize === "function";
  }

  /**
   * Tokens are only an extra source of truth for the guard; if the engine
   * cannot tokenize (or the injected database has no tokenizer), the stricter
   * keyword fallback still applies and `WITH` stays rejected.
   */
  private async tokenizeForGuard(statement: string): Promise<SqlTokenStream | undefined> {
    if (!this.tokenizerAvailable) return undefined;
    try {
      return await this.database!.tokenize!(statement);
    } catch {
      return undefined;
    }
  }

  private async loadParquetExtension(): Promise<void> {
    const connection = this.connection!;
    const repository = this.options.extensionRepository;
    if (repository !== undefined) {
      await connection.query(`SET custom_extension_repository='${escapeLiteral(repository)}'`);
    }
    try {
      await connection.query("INSTALL parquet");
      await connection.query("LOAD parquet");
    } catch (cause) {
      throw new WeiSQLError("SQL_UNSUPPORTED", "DuckDB-Wasm could not load the parquet extension", {
        engine: "duckdb-wasm",
        phase: "extension",
        repository: repository ?? "https://extensions.duckdb.org",
        cause: cause instanceof Error ? cause.message.slice(0, 300) : String(cause),
      });
    }
  }

  private async materialize(
    context: SqlAdapterOpenContext,
    index: number,
    tableName: string,
    resourcePath: string,
    declaredBytes: number,
  ): Promise<void> {
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
    const fileName = `weisql-${index}-${tableName.replace(/[^A-Za-z0-9_]/g, "_")}.parquet`;
    const database = this.database!;
    await database.registerFileBuffer(fileName, bytes);
    try {
      const prepared = await this.connection!.prepare(
        `CREATE TABLE ${quoteIdentifier(tableName)} AS SELECT * FROM read_parquet(?)`,
      );
      try {
        await prepared.query(fileName);
      } finally {
        await Promise.resolve(prepared.close?.()).catch(() => undefined);
      }
    } finally {
      await Promise.resolve(database.dropFile?.(fileName)).catch(() => undefined);
    }
  }

  private async readEngineVersion(): Promise<string> {
    const table = await this.connection!.query("SELECT version() AS version");
    const row = table.toArray()[0] as { version?: unknown } | undefined;
    return typeof row?.version === "string" ? row.version : "unknown";
  }

  private async release(): Promise<void> {
    const failures: string[] = [];
    if (this.connection !== undefined) {
      const connection = this.connection;
      this.connection = undefined;
      try {
        await connection.close();
      } catch (cause) {
        failures.push(String(cause));
      }
    }
    if (this.database !== undefined && this.ownsDatabase) {
      const database = this.database;
      try {
        await database.terminate?.();
      } catch (cause) {
        failures.push(String(cause));
      }
    }
    this.database = undefined;
    this.ownsDatabase = false;
    if (failures.length > 0 && this.stateValue !== "FAILED") {
      throw new WeiSQLError("INTERNAL_ERROR", "DuckDB-Wasm resources could not be released cleanly", {
        engine: "duckdb-wasm",
        causes: failures,
      });
    }
  }
}

export function createDuckDbWasmAdapter(options: DuckDbWasmAdapterOptions = {}): DuckDbWasmSqlAdapter {
  return new DuckDbWasmSqlAdapter(options);
}

function assertHttpUrl(value: string, option: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new WeiSQLError("INVALID_ARGUMENT", `${option} must be an absolute URL`, { [option]: value });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new WeiSQLError("INVALID_ARGUMENT", `${option} must use http or https`, { [option]: value });
  }
}

function escapeLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

function mapEngineError(cause: unknown, phase: string): WeiSQLError {
  if (cause instanceof WeiSQLError) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  const summary = message.slice(0, 300);
  if (/INTERRUPT/i.test(message) || /cancelled|canceled/i.test(message)) {
    return new WeiSQLError("QUERY_CANCELLED", "DuckDB-Wasm query was interrupted", { engine: "duckdb-wasm", phase, cause: summary });
  }
  if (/multiple statements/i.test(message)) {
    return new WeiSQLError("SQL_UNSUPPORTED", "Only one SQL statement per query is allowed", { engine: "duckdb-wasm", phase, cause: summary });
  }
  if (/Extension .* (is not available|could not)/i.test(message) || /Failed to download extension/i.test(message)) {
    return new WeiSQLError("SQL_UNSUPPORTED", "DuckDB-Wasm could not load a required extension", {
      engine: "duckdb-wasm",
      phase: "extension",
      cause: summary,
    });
  }
  if (/Permission Error|external access|disabled/i.test(message)) {
    return new WeiSQLError("SQL_UNSUPPORTED", "Statement is blocked by the read-only policy", { engine: "duckdb-wasm", phase, cause: summary });
  }
  if (/Parser Error|Binder Error|Catalog Error|Conversion Error|Invalid Input Error/i.test(message)) {
    return new WeiSQLError("INVALID_ARGUMENT", "DuckDB-Wasm rejected the statement", { engine: "duckdb-wasm", phase, cause: summary });
  }
  return new WeiSQLError("INTERNAL_ERROR", "DuckDB-Wasm execution failed", { engine: "duckdb-wasm", phase, cause: summary });
}
