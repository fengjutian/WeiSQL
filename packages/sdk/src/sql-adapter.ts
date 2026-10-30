import type { ResourceReader } from "./resource-reader.js";
import type { QueryOptions, SQLValue, WeiSQLManifest } from "./types.js";

export interface SqlAdapterCapabilities {
  engine: string;
  engineVersion?: string;
  parameterBinding: boolean;
  parquet: boolean;
  supportedFeatures: readonly string[];
  cancellation: "native" | "best-effort" | "unsupported";
}

export interface SqlAdapterOpenContext {
  manifest: Readonly<WeiSQLManifest>;
  reader: ResourceReader;
  signal?: AbortSignal;
}

export interface SqlAdapter {
  readonly capabilities: Readonly<SqlAdapterCapabilities>;
  open(context: SqlAdapterOpenContext): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    parameters?: readonly SQLValue[],
    options?: QueryOptions,
  ): Promise<readonly T[]>;
  close(): Promise<void>;
}
