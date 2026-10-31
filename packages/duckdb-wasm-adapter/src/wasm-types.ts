/**
 * The slice of the DuckDB-Wasm API this adapter depends on.
 *
 * Declaring it here (instead of importing `AsyncDuckDB` everywhere) keeps the
 * adapter testable with any object that behaves like the real database, and
 * documents exactly which surface the adapter is allowed to touch.
 */
export interface WasmArrowTable {
  toArray(): readonly unknown[];
}

/** One Arrow record batch from a streaming query. */
export interface WasmRecordBatch {
  toArray(): readonly unknown[];
}

export interface WasmPreparedStatement {
  query(...params: unknown[]): Promise<WasmArrowTable>;
  /** Streaming path; absent on minimal/injected implementations. */
  send?(...params: unknown[]): Promise<AsyncIterable<WasmRecordBatch>>;
  close?(): Promise<void> | void;
}

export interface WasmDuckDbConnection {
  query(sql: string): Promise<WasmArrowTable>;
  prepare(sql: string): Promise<WasmPreparedStatement>;
  close(): Promise<void> | void;
  cancelSent?(): Promise<boolean>;
}

export interface WasmDuckDb {
  connect(): Promise<WasmDuckDbConnection>;
  registerFileBuffer(name: string, buffer: Uint8Array): Promise<void> | void;
  dropFile?(name: string): Promise<void> | void;
  terminate?(): Promise<void> | void;
  /** DuckDB's lexer; it is what lets the guard reason about CTEs. */
  tokenize?(sql: string): Promise<{ offsets: readonly number[]; types: readonly number[] }> | { offsets: readonly number[]; types: readonly number[] };
}
