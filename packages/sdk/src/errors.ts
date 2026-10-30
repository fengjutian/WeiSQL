export type WeiSQLErrorCode =
  | "MANIFEST_INVALID" | "FORMAT_VERSION_UNSUPPORTED" | "PATH_INVALID" | "INVALID_ARGUMENT"
  | "RESOURCE_NOT_FOUND" | "RESOURCE_INTEGRITY_FAILED" | "CORS_OR_RANGE_UNSUPPORTED"
  | "RESOURCE_READ_FAILED" | "INVALID_RANGE_RESPONSE"
  | "SQL_UNSUPPORTED" | "VECTOR_DIMENSION_MISMATCH" | "VECTOR_INVALID_VALUE"
  | "INDEX_NOT_FOUND" | "DATABASE_CLOSED" | "QUERY_CANCELLED" | "INTERNAL_ERROR";

export class WeiSQLError extends Error {
  readonly code: WeiSQLErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: WeiSQLErrorCode, message: string, details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "WeiSQLError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
