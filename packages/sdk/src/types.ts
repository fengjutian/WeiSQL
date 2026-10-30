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
  index?: { engine: string; version: string; file: FileDescriptor };
}
export interface WeiSQLManifest {
  format: "weisql"; formatVersion: "1.0.0"; datasetId: string;
  tables: TableDescriptor[]; vectorCollections: VectorCollectionDescriptor[];
  metadata?: { title?: string; description?: string; createdAt?: string; builderVersion?: string };
}
export type SQLValue = string | number | bigint | boolean | null | Uint8Array | Date;
export interface QueryOptions { signal?: AbortSignal }
export interface VectorSearchOptions { topK?: number; filter?: Readonly<Record<string, string | number | boolean | null>>; signal?: AbortSignal }
export interface VectorHit { row: number; id: string | number; distance: number; metadata?: Readonly<Record<string, unknown>>; diagnostics?: { backend: string; elapsedMs?: number; exact?: boolean } }
export interface WeiSQLCapabilities {
  sql: boolean;
  vectorExactSearch: boolean;
  vectorAnnSearch: boolean;
  hybridSearch: boolean;
  resourceRange: boolean;
}
export interface OpenOptions {
  manifestUrl?: string; manifest?: unknown; mode?: "readonly"; verifyChecksums?: "none" | "manifest" | "all";
  fetch?: typeof globalThis.fetch; resourceReader?: ResourceReader; signal?: AbortSignal;
}
import type { ResourceReader } from "./resource-reader.js";

