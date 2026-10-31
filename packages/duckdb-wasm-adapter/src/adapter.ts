import { WeiSQLError } from "@weisql/sdk/errors";
import type { QueryOptions, SqlAdapter, SqlAdapterCapabilities, SqlAdapterOpenContext, SQLValue } from "@weisql/sdk";

import { quoteIdentifier, verifyTableSchema } from "./schema.js";
import { acquireOpfsLock, opfsDatabaseFileName, opfsFileExists, pruneOpfsDatabases } from "./opfs.js";
import { assertReadOnlyStatement } from "./sql-guard.js";
import type { SqlTokenStream } from "./sql-guard.js";
import { normalizeRows, toWasmParameters } from "./values.js";
import type { WasmArrowTable, WasmDuckDb, WasmDuckDbConnection } from "./wasm-types.js";

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
  /**
   * Refuse to materialize a package whose tables add up to more than this many
   * declared bytes. Checked before any table is read or materialized, so an
   * oversized package does not even load the WASM module.
   */
  maxTotalTableBytes?: number;
  /** Compare the materialized schema with the Manifest (L4). Defaults to true. */
  verifyTableSchema?: boolean;
  /**
   * Base URL of a self-hosted DuckDB extension repository. When omitted,
   * DuckDB-Wasm downloads `parquet` from `extensions.duckdb.org`.
   */
  extensionRepository?: string;
  /** Forward DuckDB-Wasm logs to the console. Defaults to silent. */
  logger?: "silent" | "console";
  /**
   * Keep the materialized database in OPFS and reuse it across sessions.
   * Requires a secure context and an adapter-owned `AsyncDuckDB`; falls back to
   * in-memory when OPFS/WebCrypto is unavailable. The cache key derives from the
   * Manifest table bytes and SHA-256, so changed data gets a new file. Defaults
   * to false.
   */
  persistToOpfs?: boolean;
}

/**
 * Browser-specific budget. Materialization costs roughly four times the Parquet
 * size (bytes in the WASM heap + the materialized table; measured at
 * `bench:wasm`), so the Node default of 256 MiB would allow ~1 GiB of browser
 * memory. 64 MiB keeps a single table near ~256 MiB and stays overridable.
 */
const DEFAULT_MAX_TABLE_BYTES = 64 * 1024 * 1024;
/**
 * Package-wide budget. The per-table limit alone would let a ten-table package
 * ask for ten times the memory; two tables' worth keeps a package near
 * ~512 MiB of browser memory while still allowing multi-table packages.
 */
const DEFAULT_MAX_TOTAL_TABLE_BYTES = 128 * 1024 * 1024;
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
    maxTotalTableBytes: number;
    verifyTableSchema: boolean;
    extensionRepository?: string;
    logger: "silent" | "console";
    persistToOpfs: boolean;
  };
  private stateValue: DuckDbWasmAdapterState = "CREATED";
  private database: WasmDuckDb | undefined;
  private connection: WasmDuckDbConnection | undefined;
  private ownsDatabase = false;
  private tokenizerAvailable = false;
  private persistRequested = false;
  private opfsExisted = false;
  private opfsReused = false;
  private opfsFileName: string | undefined;
  private opfsLock: { release(): Promise<void> } | undefined;
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

    const maxTotalTableBytes = options.maxTotalTableBytes ?? DEFAULT_MAX_TOTAL_TABLE_BYTES;
    if (!Number.isSafeInteger(maxTotalTableBytes) || maxTotalTableBytes <= 0) {
      throw new WeiSQLError("INVALID_ARGUMENT", "maxTotalTableBytes must be a positive safe integer", { maxTotalTableBytes });
    }

    this.options = {
      maxTableBytes,
      maxTotalTableBytes,
      verifyTableSchema: options.verifyTableSchema !== false,
      logger: options.logger ?? "silent",
      persistToOpfs: options.persistToOpfs === true,
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
      // Reject an oversized package before loading 34 MB of WASM and the
      // parquet extension: the budget is about declared bytes only.
      this.assertTotalBudget(context.manifest.tables);
      let databasePath: string | undefined;
      if (this.options.persistToOpfs && this.options.database === undefined) {
        try {
          const fileName = await opfsDatabaseFileName(context.manifest);
          this.opfsFileName = fileName;
          this.opfsExisted = await opfsFileExists(fileName);
          const lock = await acquireOpfsLock(`weisql-opfs-${fileName}`);
          if (lock === undefined) {
            // Another tab owns this database, or the browser has no Web Locks:
            // use memory instead of risking two writers on one OPFS file.
            this.persistRequested = false;
            this.opfsExisted = false;
            this.opfsFileName = undefined;
            databasePath = undefined;
          } else {
            this.opfsLock = lock;
            this.persistRequested = true;
            databasePath = `opfs://${fileName}`;
          }
        } catch {
          // OPFS or WebCrypto unavailable (older browser, private mode): keep
          // working in memory instead of failing the whole package.
          this.persistRequested = false;
          this.opfsExisted = false;
          this.opfsFileName = undefined;
          databasePath = undefined;
        }
      }
      try {
        await this.instantiate(databasePath);
      } catch (cause) {
        if (databasePath === undefined) throw cause;
        // Opening an existing OPFS database can fail (quota, locking, a corrupt
        // cache): retry in memory once.
        this.persistRequested = false;
        this.opfsExisted = false;
        this.opfsFileName = undefined;
        await this.releaseOpfsLock();
        await this.instantiate(undefined);
      }
      this.connection = await this.database!.connect();
      await this.loadParquetExtension();
      const reuse = this.persistRequested && this.opfsExisted && await this.tablesExist(context.manifest);
      if (reuse) {
        this.opfsReused = true;
      } else {
        if (this.persistRequested && this.opfsExisted) await this.dropTables(context.manifest);
        for (const [index, table] of context.manifest.tables.entries()) {
          await this.materialize(context, index, table.name, table.file.path, table.file.bytes);
        }
        if (this.persistRequested) {
          await this.flushToOpfs();
          await this.pruneOpfs();
        }
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
          ...(this.persistRequested ? ["opfs"] : []),
          ...(this.opfsReused ? ["opfs-reused"] : []),
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
    const maxRows = options?.maxRows;
    if (maxRows !== undefined && (!Number.isSafeInteger(maxRows) || maxRows <= 0)) {
      throw new WeiSQLError("INVALID_ARGUMENT", "maxRows must be a positive safe integer", { maxRows });
    }
    const tokens = await this.tokenizeForGuard(statement);
    const verb = assertReadOnlyStatement(statement, tokens);
    const connection = this.connection!;
    // Only a table expression can be wrapped. DESCRIBE/SHOW/SUMMARIZE/EXPLAIN
    // return bounded metadata rows, so they are checked after execution.
    const wrappable = verb === "SELECT" || verb === "VALUES" || verb === "TABLE";
    const executable = maxRows !== undefined && wrappable ? withRowLimit(statement, maxRows) : statement;
    const prepared = await connection.prepare(executable).catch((cause: unknown) => {
      throw mapEngineError(cause, "prepare");
    });
    let cancelled = false;
    let detach = (): void => {};
    try {
      const values = toWasmParameters(parameters);
      const execution = prepared.query(...values).catch((cause: unknown) => {
        throw mapEngineError(cause, "execute");
      });
      const table = await new Promise<WasmArrowTable>((resolve, reject) => {
        if (signal === undefined) {
          execution.then(resolve, reject);
          return;
        }
        const onAbort = (): void => {
          cancelled = true;
          // A single-threaded DuckDB-Wasm cannot preempt CPU-bound work in the
          // worker: `cancelSent()` returns false and the request is only
          // processed once the query finishes. Ask anyway (it helps queued or
          // threaded builds), then stop waiting and say so in the error.
          void Promise.resolve(connection.cancelSent?.()).catch(() => undefined);
          reject(new WeiSQLError("QUERY_CANCELLED", "DuckDB-Wasm query was cancelled; the engine may still be running", {
            engine: "duckdb-wasm",
            engineMayStillRun: true,
          }));
        };
        detach = () => signal.removeEventListener("abort", onAbort);
        signal.addEventListener("abort", onAbort, { once: true });
        execution.then(resolve, reject);
      });
      const rows = normalizeRows(table.toArray());
      if (maxRows !== undefined && rows.length > maxRows) {
        throw new WeiSQLError("INVALID_ARGUMENT", "Query returned more rows than maxRows", {
          maxRows,
          engine: "duckdb-wasm",
        });
      }
      return rows as T[];
    } finally {
      detach();
      if (cancelled) {
        // Do not await: the worker is still busy, so close() would queue behind
        // the query and make cancellation look much slower than it is.
        void Promise.resolve(prepared.close?.()).catch(() => undefined);
      } else {
        await Promise.resolve(prepared.close?.()).catch(() => undefined);
      }
    }
  }

  /**
   * Streams Arrow record batches. Aborting stops the wait immediately (the
   * single-threaded engine may still finish); `maxRows` is checked per row.
   */
  async stream<T extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    parameters: readonly SQLValue[] = [],
    options?: QueryOptions,
  ): Promise<AsyncIterable<T>> {
    this.ensureReady();
    const signal = options?.signal;
    if (signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Query was cancelled before execution");
    const maxRows = options?.maxRows;
    if (maxRows !== undefined && (!Number.isSafeInteger(maxRows) || maxRows <= 0)) {
      throw new WeiSQLError("INVALID_ARGUMENT", "maxRows must be a positive safe integer", { maxRows });
    }
    const tokens = await this.tokenizeForGuard(statement);
    const verb = assertReadOnlyStatement(statement, tokens);
    const connection = this.connection!;
    const wrappable = verb === "SELECT" || verb === "VALUES" || verb === "TABLE";
    const executable = maxRows !== undefined && wrappable ? withRowLimit(statement, maxRows) : statement;
    const prepared = await connection.prepare(executable).catch((cause: unknown) => {
      throw mapEngineError(cause, "prepare");
    });
    if (prepared.send === undefined) {
      await Promise.resolve(prepared.close?.()).catch(() => undefined);
      throw new WeiSQLError("SQL_UNSUPPORTED", "This database does not support streaming queries", {
        engine: "duckdb-wasm",
      });
    }
    const values = toWasmParameters(parameters);
    let cancelled = false;
    let detach = (): void => {};
    if (signal !== undefined) {
      const onAbort = (): void => {
        cancelled = true;
        void Promise.resolve(connection.cancelSent?.()).catch(() => undefined);
      };
      detach = () => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
    }
    const cancelError = (): WeiSQLError =>
      new WeiSQLError("QUERY_CANCELLED", "DuckDB-Wasm query was cancelled; the engine may still be running", {
        engine: "duckdb-wasm",
        engineMayStillRun: true,
      });
    let abortReject: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abortReject = () => reject(cancelError());
    });
    const rejectOnAbort = abortReject as () => void;
    void aborted.catch(() => undefined);
    if (signal !== undefined) {
      if (signal.aborted) rejectOnAbort();
      else signal.addEventListener("abort", rejectOnAbort, { once: true });
    }
    // The single-threaded worker may be busy for a long time, so both `send()`
    // and every `next()` are raced against the abort signal: waiting for
    // cancellation to be noticed only at batch boundaries would not match the
    // "stop waiting immediately" contract.
    let reader;
    try {
      const started = prepared.send(...values);
      reader = await (signal === undefined ? started : Promise.race([started, aborted]));
    } catch (cause) {
      if (cancelled) {
        void Promise.resolve(prepared.close?.()).catch(() => undefined);
        throw cancelError();
      }
      await Promise.resolve(prepared.close?.()).catch(() => undefined);
      throw mapEngineError(cause, "execute");
    }
    const iterator = reader[Symbol.asyncIterator]();
    return (async function* (): AsyncGenerator<T> {
      let count = 0;
      try {
        for (;;) {
          const step = await (signal === undefined ? iterator.next() : Promise.race([iterator.next(), aborted]));
          if (step.done === true) break;
          for (const row of normalizeRows(step.value.toArray())) {
            count += 1;
            if (maxRows !== undefined && count > maxRows) {
              throw new WeiSQLError("INVALID_ARGUMENT", "Query returned more rows than maxRows", {
                maxRows,
                engine: "duckdb-wasm",
              });
            }
            yield row as T;
          }
        }
      } finally {
        if (signal !== undefined) signal.removeEventListener("abort", rejectOnAbort);
        detach();
        // Do not await an abandoned read: the worker is still busy with the
        // cancelled query, so waiting here would defeat the early return.
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
        if (cancelled) void Promise.resolve(prepared.close?.()).catch(() => undefined);
        else await Promise.resolve(prepared.close?.()).catch(() => undefined);
      }
    })();
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

  private async tablesExist(manifest: SqlAdapterOpenContext["manifest"]): Promise<boolean> {
    try {
      for (const table of manifest.tables) {
        await this.connection!.query(`SELECT 1 FROM ${quoteIdentifier(table.name)} LIMIT 0`);
      }
      return true;
    } catch {
      return false;
    }
  }

  private async dropTables(manifest: SqlAdapterOpenContext["manifest"]): Promise<void> {
    for (const table of manifest.tables) {
      await this.connection!.query(`DROP TABLE IF EXISTS ${quoteIdentifier(table.name)}`);
    }
  }

  private async flushToOpfs(): Promise<void> {
    try {
      await this.database?.flushFiles?.();
    } catch {
      // Persistence is an optimization: do not fail `open()` because a flush
      // failed, but stop advertising the feature for this instance.
      this.persistRequested = false;
    }
  }

  private async pruneOpfs(): Promise<void> {
    if (this.opfsFileName === undefined) return;
    try {
      await pruneOpfsDatabases(this.opfsFileName);
    } catch {
      // Eviction is housekeeping; a failure must not break the open path.
    }
  }

  private async releaseOpfsLock(): Promise<void> {
    const lock = this.opfsLock;
    this.opfsLock = undefined;
    if (lock !== undefined) await lock.release().catch(() => undefined);
  }

  private async instantiate(databasePath?: string): Promise<void> {
    if (this.options.database !== undefined) {
      this.database = this.options.database;
      this.ownsDatabase = false;
      this.persistRequested = false;
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
    const accessMode = (duckdb as unknown as { DuckDBAccessMode?: { READ_WRITE: number } }).DuckDBAccessMode?.READ_WRITE;
    const config = {
      path: databasePath ?? ":memory:",
      ...(databasePath === undefined || accessMode === undefined ? {} : { accessMode }),
      query: { castDecimalToDouble: true },
    };
    try {
      await database.open(config);
    } catch (cause) {
      await Promise.resolve(database.terminate?.()).catch(() => undefined);
      throw cause;
    }
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
      if (this.persistRequested) {
        try {
          await database.flushFiles?.();
        } catch (cause) {
          failures.push(String(cause));
        }
      }
      try {
        await database.terminate?.();
      } catch (cause) {
        failures.push(String(cause));
      }
    }
    this.database = undefined;
    this.ownsDatabase = false;
    this.persistRequested = false;
    this.opfsExisted = false;
    await this.releaseOpfsLock();
    this.opfsFileName = undefined;
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

/**
 * Wraps a read-only statement so the engine stops at `maxRows + 1`. Kept in sync
 * with the Node adapter; `maxRows` is a validated safe integer, so the
 * interpolation cannot inject SQL.
 */
function withRowLimit(statement: string, maxRows: number): string {
  const trimmed = statement.replace(/[;\s]+$/, "");
  return `SELECT * FROM (${trimmed}) AS "weisql_row_limit" LIMIT ${maxRows + 1}`;
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
