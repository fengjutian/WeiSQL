import { WeiSQLError } from "./errors.js";
import { validateManifest } from "./manifest.js";
import type { OpenOptions, QueryOptions, SQLValue, VectorHit, VectorSearchOptions, WeiSQLManifest } from "./types.js";

export interface WeiSQLDatabase {
  readonly manifest: Readonly<WeiSQLManifest>;
  sql<T extends Record<string, unknown> = Record<string, unknown>>(query: string, params?: readonly SQLValue[], options?: QueryOptions): Promise<readonly T[]>;
  readonly vector: { search(vectorName: string, queryVector: Float32Array | readonly number[], options?: VectorSearchOptions): Promise<readonly VectorHit[]> };
  close(): Promise<void>;
}

class Database implements WeiSQLDatabase {
  private closed = false;
  readonly manifest: Readonly<WeiSQLManifest>;
  readonly vector;
  constructor(manifest: WeiSQLManifest) {
    this.manifest = manifest;
    this.vector = { search: this.search.bind(this) };
  }
  async sql<T extends Record<string, unknown>>(_query: string, _params: readonly SQLValue[] = [], options?: QueryOptions): Promise<readonly T[]> {
    this.ensureOpen(); aborted(options?.signal);
    throw new WeiSQLError("SQL_UNSUPPORTED", "No SQL adapter is configured in this SDK skeleton");
  }
  private async search(vectorName: string, queryVector: Float32Array | readonly number[], options?: VectorSearchOptions): Promise<readonly VectorHit[]> {
    this.ensureOpen(); aborted(options?.signal);
    const topK = options?.topK ?? 10;
    if (!Number.isSafeInteger(topK) || topK <= 0) throw new WeiSQLError("VECTOR_INVALID_VALUE", "topK must be a positive integer", { topK });
    const vector = this.manifest.vectorCollections.find(item => item.name === vectorName);
    if (!vector) throw new WeiSQLError("INDEX_NOT_FOUND", `Unknown vector '${vectorName}'`);
    if (queryVector.length !== vector.dimension) throw new WeiSQLError("VECTOR_DIMENSION_MISMATCH", "Query vector dimension does not match manifest", { expected: vector.dimension, actual: queryVector.length });
    for (let i = 0; i < queryVector.length; i++) if (!Number.isFinite(queryVector[i])) throw new WeiSQLError("VECTOR_INVALID_VALUE", "Query vector contains a non-finite value", { position: i });
    throw new WeiSQLError("INDEX_NOT_FOUND", "No vector adapter is configured in this SDK skeleton");
  }
  async close(): Promise<void> { this.closed = true; }
  private ensureOpen(): void { if (this.closed) throw new WeiSQLError("DATABASE_CLOSED", "Database is closed"); }
}

export async function open(options: OpenOptions): Promise<WeiSQLDatabase> {
  if (options.mode !== undefined && options.mode !== "readonly") throw new WeiSQLError("MANIFEST_INVALID", "V1 only supports readonly mode");
  aborted(options.signal);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (!fetcher) throw new WeiSQLError("INTERNAL_ERROR", "No fetch implementation is available");
  let response: Response;
  const requestInit: RequestInit = options.signal ? { signal: options.signal } : {};
  try { response = await fetcher(options.manifestUrl, requestInit); }
  catch (cause) { if (options.signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Manifest request was cancelled"); throw new WeiSQLError("RESOURCE_NOT_FOUND", "Manifest could not be loaded", { cause: String(cause) }); }
  if (!response.ok) throw new WeiSQLError("RESOURCE_NOT_FOUND", `Manifest request failed with HTTP ${response.status}`, { status: response.status });
  let json: unknown;
  try { json = await response.json(); } catch { throw new WeiSQLError("MANIFEST_INVALID", "Manifest is not valid JSON"); }
  return new Database(validateManifest(json));
}

function aborted(signal?: AbortSignal): void { if (signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Operation was cancelled"); }
