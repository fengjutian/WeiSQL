export type WeiSQLErrorCode =
  | "MANIFEST_INVALID" | "FORMAT_VERSION_UNSUPPORTED" | "PATH_INVALID" | "INVALID_ARGUMENT"
  | "RESOURCE_NOT_FOUND" | "RESOURCE_INTEGRITY_FAILED" | "CORS_OR_RANGE_UNSUPPORTED"
  | "RESOURCE_READ_FAILED" | "INVALID_RANGE_RESPONSE"
  | "SQL_UNSUPPORTED" | "VECTOR_DIMENSION_MISMATCH" | "VECTOR_INVALID_VALUE"
  | "INDEX_NOT_FOUND" | "DATABASE_CLOSED" | "QUERY_CANCELLED" | "INTERNAL_ERROR";

export interface WeiSQLErrorOptions {
  code: WeiSQLErrorCode;
  message: string;
  details?: Readonly<Record<string, unknown>>;
  cause?: unknown;
}

export class WeiSQLError extends Error {
  readonly code: WeiSQLErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(options: WeiSQLErrorOptions);
  constructor(code: WeiSQLErrorCode, message: string, details?: Readonly<Record<string, unknown>>, cause?: unknown);
  constructor(
    codeOrOptions: WeiSQLErrorCode | WeiSQLErrorOptions,
    message?: string,
    details?: Readonly<Record<string, unknown>>,
    cause?: unknown,
  ) {
    let options: WeiSQLErrorOptions;
    if (typeof codeOrOptions === "string") {
      options = { code: codeOrOptions, message: message ?? codeOrOptions };
      if (details !== undefined) options.details = details;
      if (cause !== undefined) options.cause = cause;
    } else {
      options = codeOrOptions;
    }
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "WeiSQLError";
    this.code = options.code;
    if (options.details !== undefined) this.details = options.details;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
