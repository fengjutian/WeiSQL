import type { ResourceReader } from "./resource-reader.js";
import type { SqlAdapter } from "./sql-adapter.js";
import type { VectorAdapter } from "./vector-adapter.js";

export type WeiSQLScalarType = "string" | "int32" | "int64" | "float32" | "float64" | "boolean" | "timestamp" | "date" | "json";
export interface FileDescriptor { path: string; bytes: number; sha256: string }
export interface ColumnDescriptor { name: string; type: WeiSQLScalarType; nullable: boolean }
export interface TableDescriptor { name: string; file: FileDescriptor; format: "parquet"; columns: ColumnDescriptor[]; primaryKey: string[] }
export type VectorMetric = "cosine" | "l2" | "ip";
export interface IdMapDescriptor {
  data: FileDescriptor & { format: "jsonl" };
  offsets: FileDescriptor & { format: "uint64-le" };
  count: number;
  uniqueIds: boolean;
}
export interface VectorCollectionDescriptor {
  name: string; tableName: string; idColumn: string;
  count: number; dimension: number; metric: VectorMetric;
  encoding: "f32-le-row-major"; data: FileDescriptor; idMap: IdMapDescriptor;
  index?: { engine: string; version: string; file: FileDescriptor; params?: Readonly<Record<string, number>> };
}
/**
 * Full-text index over one text column of one table.
 *
 * `documentCount` and `averageDocumentLength` are declared rather than derived:
 * a BM25 query must not rescan the collection to recompute them.
 */
export interface TextIndexDescriptor {
  name: string;
  tableName: string;
  column: string;
  idColumn: string;
  documentCount: number;
  termCount: number;
  averageDocumentLength: number;
  /** Sorted term → postings JSONL. */
  data: FileDescriptor;
  /** UInt64 LE term start offsets; count = termCount. */
  termOffsets: FileDescriptor;
  /** UInt32 LE per-document token counts; count = documentCount. */
  docLengths: FileDescriptor;
  /** Row → business ID, same shape as the vector ID Map. */
  idMap: IdMapDescriptor;
  k1?: number;
  b?: number;
}
export interface WeiSQLManifest {
  format: "weisql"; formatVersion: "1.0.0"; datasetId: string;
  tables: TableDescriptor[]; vectorCollections: VectorCollectionDescriptor[];
  textIndexes?: TextIndexDescriptor[];
  metadata?: { title?: string; description?: string; createdAt?: string; builderVersion?: string };
}
export type SQLValue = string | number | bigint | boolean | null | Uint8Array | Date;
export interface QueryOptions { signal?: AbortSignal }
export interface VectorFirstOptions {
  /** Candidate window before the first expansion; defaults to `topK × 4`. */
  initialCandidates?: number;
  /** Added per expansion round; defaults to `topK × 4`. */
  expansionStep?: number;
  /** Hard cap on the candidate window; defaults to 10000. */
  maxCandidates?: number;
}
export type HybridStrategy = "exact-filter-first" | "vector-first";
export interface VectorSearchOptions {
  topK?: number;
  filter?: Readonly<Record<string, string | number | boolean | null>>;
  signal?: AbortSignal;
  /** Requires `filter`. Defaults to `exact-filter-first`. */
  strategy?: HybridStrategy;
  vectorFirst?: VectorFirstOptions;
}
export interface VectorHit { row: number; id: string | number; distance: number; metadata?: Readonly<Record<string, unknown>>; diagnostics?: { backend: string; elapsedMs?: number; exact?: boolean; strategy?: HybridStrategy; filteredCandidates?: number; candidatesScanned?: number; candidateCap?: number } }
export interface WeiSQLCapabilities {
  sql: boolean;
  vectorExactSearch: boolean;
  vectorAnnSearch: boolean;
  hybridSearch: boolean;
  textSearch: boolean;
  resourceRange: boolean;
}
export type RuntimeState = "OPENING" | "READY" | "CLOSING" | "CLOSED" | "FAILED";
export interface CacheOptions {
  /** Total bytes the cache may retain; defaults to 32 MiB. */
  maxCacheBytes?: number;
  /** Ranges larger than this are not cached; defaults to 1 MiB. */
  maxEntryBytes?: number;
  /** Concurrent underlying reads; defaults to 8. */
  maxConcurrentReads?: number;
  /** Publication identity used in cache keys; defaults to the dataset ID. */
  version?: string;
}
export interface OpenOptions {
  manifestUrl?: string; manifest?: unknown; mode?: "readonly"; verifyChecksums?: "none" | "manifest" | "all";
  fetch?: typeof globalThis.fetch; resourceReader?: ResourceReader; sqlAdapter?: SqlAdapter; vectorAdapter?: VectorAdapter; cache?: CacheOptions; signal?: AbortSignal;
}

