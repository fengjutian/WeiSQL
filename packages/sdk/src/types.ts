export type ColumnType =
  | "utf8" | "int32" | "int64" | "float32"
  | "float64" | "boolean" | "binary" | "timestamp";

export interface ManifestFile {
  path: string;
  format: string;
  rows?: number;
  bytes: number;
  sha256: string;
}

export interface ManifestColumn { name: string; type: ColumnType; nullable: boolean }

export interface ManifestTable {
  name: string;
  schema: ManifestColumn[];
  primaryKey?: string[];
  files: ManifestFile[];
}

export interface ManifestVector {
  name: string;
  sourceTable: string;
  idColumn: string;
  dimension: number;
  elementType: "float32";
  metric: "cosine" | "l2" | "ip";
  normalization?: "unit" | "not-required-by-format" | "unknown";
  files: ManifestFile[];
  index?: { engine: string; engineVersion?: string; path: string; sha256?: string };
}

export interface WeiSQLManifest {
  format: "weisql-ai";
  formatVersion: string;
  datasetId: string;
  createdAt?: string;
  metadata?: Record<string, unknown>;
  tables: ManifestTable[];
  vectors?: ManifestVector[];
  features?: {
    sql?: boolean;
    vectorSearch?: boolean;
    fullTextSearch?: boolean;
    hybridSearch?: boolean;
  };
}

export type SQLValue = string | number | bigint | boolean | null | Uint8Array | Date;
export interface QueryOptions { signal?: AbortSignal }
export interface VectorSearchOptions {
  topK?: number;
  filter?: Readonly<Record<string, string | number | boolean | null>>;
  signal?: AbortSignal;
}
export interface VectorHit {
  id: string | number;
  distance: number;
  metadata?: Readonly<Record<string, unknown>>;
  diagnostics?: { backend: string; elapsedMs?: number };
}
export interface OpenOptions {
  manifestUrl: string;
  mode?: "readonly";
  verifyChecksums?: "none" | "manifest" | "all";
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}
