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
  /**
   * Optional sorted `id → row` index. Without it, filtering scans the whole ID
   * Map per query to invert IDs; with it, each lookup is a binary search.
   */
  idIndex?: {
    data: FileDescriptor & { format: "jsonl" };
    offsets: FileDescriptor & { format: "uint64-le" };
    count: number;
    idType: "string" | "integer";
    uniqueIds: boolean;
  };
  index?: { engine: string; version: string; file: FileDescriptor; params?: Readonly<Record<string, number>> };
}
/**
 * Full-text index over one text column of one table.
 *
 * `documentCount` and `averageDocumentLength` are declared rather than derived:
 * a BM25 query must not rescan the collection to recompute them.
 */
export interface TextIndexDescriptor {  name: string;
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
  /**
   * Optional row → original document text, so retrieval can assemble context
   * without a Parquet reader. Stored as JSONL plus UInt64 offsets.
   */
  documents?: { data: FileDescriptor & { format: "jsonl" }; offsets: FileDescriptor & { format: "uint64-le" } };
  k1?: number;
  b?: number;
}
/**
 * Detached Ed25519 signature over the canonical Manifest (excluding `signature`
 * itself). `keyId` is the SHA-256 fingerprint of `publicKey`, which lets callers
 * pin an expected publisher without shipping a trust store in the SDK.
 */
export interface ManifestSignature {
  algorithm: "ed25519";
  /** `sha256:<hex>` fingerprint of the SPKI public key. */
  keyId: string;
  /** Base64 SPKI public key. */
  publicKey: string;
  /** Base64 Ed25519 signature, 64 bytes. */
  value: string;
}
/**
 * A root key authorizing a signer key, with a validity window. The root's
 * signature covers the signer key, the validity window and both fingerprints,
 * so a delegation cannot be lifted onto another key.
 */
export interface ManifestAuthorization {
  algorithm: "ed25519";
  rootKeyId: string;
  rootPublicKey: string;
  keyId: string;
  publicKey: string;
  /** ISO timestamps: inclusive start, exclusive end. */
  validFrom: string;
  validUntil: string;
  value: string;
}
export interface WeiSQLManifest {
  format: "weisql"; formatVersion: "1.0.0"; datasetId: string;
  tables: TableDescriptor[]; vectorCollections: VectorCollectionDescriptor[];
  textIndexes?: TextIndexDescriptor[];
  signature?: ManifestSignature;
  signatures?: readonly ManifestSignature[];
  /** Root-key delegations; consumers pin the root instead of every release key. */
  authorizations?: readonly ManifestAuthorization[];
  metadata?: { title?: string; description?: string; createdAt?: string; builderVersion?: string };
}
export type SQLValue = string | number | bigint | boolean | null | Uint8Array | Date;
export interface QueryOptions {
  signal?: AbortSignal;
  /**
   * Upper bound on returned rows. Adapters reject with `INVALID_ARGUMENT` once
   * the result exceeds it instead of truncating silently. For plain SELECTs the
   * engine is asked for at most `maxRows + 1` rows, so the extra row is the only
   * one materialized beyond the budget.
   */
  maxRows?: number;
}
export interface VectorFirstOptions {
  /** Candidate window before the first expansion; defaults to `topK × 4`. */
  initialCandidates?: number;
  /** Added per expansion round; defaults to `topK × 4`. */
  expansionStep?: number;
  /** Hard cap on the candidate window; defaults to 10000. */
  maxCandidates?: number;
}
export type HybridStrategy = "exact-filter-first" | "vector-first";

/** Scalar values a filter may compare against. `Date` is only valid for date/timestamp columns. */
export type FilterScalar = string | number | boolean | Date | null;

/**
 * One column condition:
 * - a scalar means equality (`null` becomes `IS NULL`);
 * - an array means `IN (...)` (membership, at least one value);
 * - `{ in }` is the explicit form of membership;
 * - `{ gte, gt, lte, lt }` is a range (at least one bound);
 * - `{ ne }` means `<>`.
 */
export type FilterCondition =
  | FilterScalar
  | readonly FilterScalar[]
  | { readonly in: readonly FilterScalar[] }
  | { readonly gte?: FilterScalar; readonly gt?: FilterScalar; readonly lte?: FilterScalar; readonly lt?: FilterScalar }
  | { readonly ne: FilterScalar };

export type FilterExpression = Readonly<Record<string, FilterCondition>>;
export interface VectorSearchOptions {
  topK?: number;
  /**
   * Equality, membership or range conditions on declared columns, AND-combined.
   * `json` columns remain unsupported: JSON equality needs a canonical form, and
   * guessing one would silently match nothing.
   */
  filter?: FilterExpression;
  signal?: AbortSignal;
  /** Requires `filter`. Defaults to `exact-filter-first`. */
  strategy?: HybridStrategy;
  vectorFirst?: VectorFirstOptions;
}
export interface VectorHit { row: number; id: string | number; distance: number; metadata?: Readonly<Record<string, unknown>>; diagnostics?: { backend: string; elapsedMs?: number; exact?: boolean; strategy?: HybridStrategy; postFiltered?: boolean; filteredCandidates?: number; candidatesScanned?: number; candidateCap?: number } }
export interface WeiSQLCapabilities {
  sql: boolean;
  vectorExactSearch: boolean;
  vectorAnnSearch: boolean;
  hybridSearch: boolean;
  textSearch: boolean;
  /** Reciprocal-rank fusion across vector and text sources. */
  fusionSearch: boolean;
  /** Evidence assembly over fused results, requires a text index with documents. */
  ragSearch: boolean;
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
  /**
   * Per-resource ceiling for L3 verification, in declared bytes; defaults to
   * 64 MiB. Raising it lets a package with one large Parquet file pass checks,
   * but verification buffers that resource in memory to hash it.
   */
  maxResourceBytes?: number;
  /** Total declared-bytes ceiling for L3 verification; defaults to 512 MiB. */
  maxTotalBytes?: number;
}
export interface HybridVectorSource {
  name: string;
  query: Float32Array | readonly number[];
  /** Candidates fetched from this source; defaults to `max(topK × 4, topK)`. */
  topK?: number;
}
export interface HybridTextSource {
  name: string;
  query: string;
  /** Candidates fetched from this source; defaults to `max(topK × 4, topK)`. */
  topK?: number;
}
export interface HybridSearchOptions {
  topK?: number;
  /** RRF constant; defaults to 60. */
  k?: number;
  vector?: HybridVectorSource;
  text?: HybridTextSource;
  signal?: AbortSignal;
}
export interface HybridFusionHit {
  id: string | number;
  /** Fused RRF score; higher is better. Not comparable with BM25 or distance. */
  score: number;
  /** 1-based rank per contributing source. */
  ranks: Readonly<Record<string, number>>;
  vector?: { row: number; distance: number };
  text?: { row: number; score: number };
  diagnostics?: { backend: "rrf"; k: number; elapsedMs?: number };
}
export interface RagSearchOptions {
  topK?: number;
  /** RRF constant; defaults to 60. */
  k?: number;
  /** Character budget for assembled evidence; defaults to 4000. */
  maxCharacters?: number;
  vector?: HybridVectorSource;
  /** Required: RAG needs document text, which only a text index carries. */
  text?: HybridTextSource;
  signal?: AbortSignal;
}
export interface RagEvidence {
  id: string | number;
  text: string;
  /** 1-based position in the fused ranking. */
  rank: number;
  characters: number;
  /** True when this fragment was cut to fit the character budget. */
  truncated: boolean;
  /** Where the cut happened: a sentence, a word, or mid-character. */
  boundary: "none" | "sentence" | "word" | "character";
  ranks: Readonly<Record<string, number>>;
}
export interface RagResult {
  evidences: readonly RagEvidence[];
  usedCharacters: number;
  truncated: boolean;
  /** Fused hits that were left out: no text, or the budget was already spent. */
  droppedHits: number;
  diagnostics: { backend: "rrf"; k: number; maxCharacters: number; elapsedMs?: number };
}

