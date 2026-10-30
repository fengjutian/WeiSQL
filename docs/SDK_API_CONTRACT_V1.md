# WeiSQL AI TypeScript SDK API 契约（V1 草案）

状态：精确向量最小 Runtime 已实现；SQL Adapter、ANN 与 Hybrid 待实现。API 名称仍可在首个稳定版本前调整。

## 1. 生命周期

```ts
export interface OpenOptions {
  /** Exactly one Manifest source must be provided. */
  manifestUrl?: string;
  manifest?: unknown;
  mode?: "readonly"; // V1 only
  verifyChecksums?: "none" | "manifest" | "all";
  fetch?: typeof globalThis.fetch;
  resourceReader?: ResourceReader;
  sqlAdapter?: SqlAdapter;
  signal?: AbortSignal;
}

export interface WeiSQLDatabase {
  readonly manifest: Readonly<WeiSQLManifest>;
  readonly state: RuntimeState;
  sql<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    params?: readonly SQLValue[],
    options?: QueryOptions,
  ): Promise<readonly T[]>;
  vector: {
    search(
      vectorName: string,
      queryVector: Float32Array | readonly number[],
      options?: VectorSearchOptions,
    ): Promise<readonly VectorHit[]>;
  };
  text: {
    search(
      indexName: string,
      query: string,
      options?: TextSearchOptions,
    ): Promise<readonly TextHit[]>;
  };
  hybrid: {
    search(options: HybridSearchOptions): Promise<readonly HybridFusionHit[]>;
  };
  capabilities(): Readonly<WeiSQLCapabilities>;
  close(): Promise<void>;
}

export type SQLValue = string | number | bigint | boolean | null | Uint8Array | Date;
export interface QueryOptions { signal?: AbortSignal; }
export interface TextSearchOptions { topK?: number; signal?: AbortSignal; }
export interface TextHit {
  row: number;
  id: string | number;
  /** BM25 relevance: higher is better, the opposite of `VectorHit.distance`. */
  score: number;
  diagnostics?: { backend: string; elapsedMs?: number };
}
export interface HybridSearchOptions {
  topK?: number;
  /** RRF constant; defaults to 60. */
  k?: number;
  vector?: { name: string; query: Float32Array | readonly number[]; topK?: number };
  text?: { name: string; query: string; topK?: number };
  signal?: AbortSignal;
}
export interface HybridFusionHit {
  id: string | number;
  /** Fused RRF score, higher is better; not comparable with BM25 or distance. */
  score: number;
  /** 1-based rank per contributing source. */
  ranks: Readonly<Record<string, number>>;
  vector?: { row: number; distance: number };
  text?: { row: number; score: number };
  diagnostics?: { backend: "rrf"; k: number; elapsedMs?: number };
}
export interface VectorSearchOptions {
  topK?: number;
  /** Field → scalar equality, AND semantics; V1 implements `exact-filter-first`. */
  filter?: Readonly<Record<string, string | number | boolean | null>>;
  signal?: AbortSignal;
}
export interface VectorHit {
  row: number;
  id: string | number;
  distance: number;
  metadata?: Readonly<Record<string, unknown>>;
  diagnostics?: { backend: string; elapsedMs?: number };
}
```

当前 `resourceReader` 注入后，SDK 使用 Manifest 的原始 Float32 与 Indexed ID Map 执行 TypeScript 精确搜索。未注入 Reader 时向量调用返回 `INDEX_NOT_FOUND`。数据库拥有注入 Reader 的生命周期，并在 `close()` 时关闭它。

## 2. Required semantics

- `open()` validates the manifest structure, format identifier and supported major version before opening data resources.
- `mode` only accepts `readonly` in V1. A caller must not infer write support from an underlying engine's capabilities.
- SQL values must be passed as parameters. The SDK must not interpolate untrusted values into SQL strings.
- `topK` must be a positive integer; default candidate is 10, subject to documented final implementation.
- `distance` is always normalized so lower is better. For cosine, `distance = 1 - cosine_similarity`.
- The SDK must not silently ignore an unavailable vector index. It either follows an explicit exact-search fallback option or returns `INDEX_NOT_FOUND`.
- `close()` is idempotent. Calls after close return `DATABASE_CLOSED`.
- Cancellation is best-effort; if the underlying engine cannot interrupt a running query, the API documents that limitation.
- Returned rows and hits are immutable by contract; implementation may freeze objects in development builds.

## 3. SQL adapter boundaries

DuckDB is an adapter, not the public API contract. The public SDK should avoid leaking DuckDB-specific connection, relation or extension types. Browser and Node adapters may have different supported SQL functions; expose a capability report rather than promising complete parity.

```ts
// Actual V1 shape: booleans describing this instance's wiring. Engine details
// (engine name, metrics, persistedIndex) live on the adapter's own capabilities.
interface WeiSQLCapabilities {
  sql: boolean;
  vectorExactSearch: boolean;
  vectorAnnSearch: boolean;
  hybridSearch: boolean;
  textSearch: boolean;
  fusionSearch: boolean;
  resourceRange: boolean;
}
```

## 4. Error codes

| Code | Meaning | Expected response |
|---|---|---|
| `MANIFEST_INVALID` | Manifest JSON/schema invalid | Show validation detail; do not open resources |
| `FORMAT_VERSION_UNSUPPORTED` | Unsupported major format version | Ask user to upgrade SDK or regenerate dataset |
| `PATH_INVALID` | Unsafe or invalid resource path | Reject before fetching |
| `INVALID_ARGUMENT` | API argument is invalid | Correct the caller input before retrying |
| `RESOURCE_NOT_FOUND` | A referenced file cannot be loaded | Check deployment output and case-sensitive path |
| `RESOURCE_READ_FAILED` | Resource transport or HTTP request failed | Inspect network/server diagnostics and retry policy |
| `RESOURCE_INTEGRITY_FAILED` | Size or checksum mismatch | Stop query; never silently continue |
| `CORS_OR_RANGE_UNSUPPORTED` | Remote access mode is incompatible with requested loading strategy | Explain server header requirement or use multi-file mode |
| `INVALID_RANGE_RESPONSE` | Range response is malformed, unsatisfiable or differs from the request | Reject bytes and inspect CDN/proxy behavior |
| `SQL_UNSUPPORTED` | Query/function unavailable in current adapter | Report runtime and engine capability |
| `VECTOR_DIMENSION_MISMATCH` | Query dimension differs from index | Return expected and actual dimensions |
| `VECTOR_INVALID_VALUE` | Vector contains NaN/Infinity or forbidden zero vector | Reject input and identify position where possible |
| `INDEX_NOT_FOUND` | Manifest points to missing or unavailable index | Explicit fallback only when enabled |
| `DATABASE_CLOSED` | Operation attempted after close | Reopen database |
| `QUERY_CANCELLED` | Operation was cancelled | Caller may retry if appropriate |
| `INTERNAL_ERROR` | Unexpected adapter failure | Include diagnostic ID, avoid leaking secrets |

## 5. Security and resource limits

- Manifest paths are relative and normalized before fetch/open. Reject absolute paths, `..`, encoded traversal, unexpected schemes and duplicate canonical paths.
- Apply configurable limits before allocation: maximum manifest bytes, file bytes, vector dimension, row count and query result rows.
- SHA-256 verification detects accidental corruption but does not prove that a dataset is trusted. For authenticity, a future release may support a signed manifest and trusted public keys.
- Public static datasets are downloadable by design. Do not package secrets, access tokens, private customer data or server-only prompts.
- SQL query execution should use parameter binding where available. If the adapter lacks parameter binding for a particular operation, that operation must not accept untrusted values.

## 6. API acceptance tests

1. Open a valid manifest and reject unsupported format versions.
2. Reject traversal paths before any network request is made.
3. Reject checksum and declared-size mismatches when verification is enabled.
4. Verify parameterized SQL values are not treated as SQL syntax.
5. Verify `topK=0`, negative values, non-integers and dimension mismatch return stable errors.
6. Verify `close()` can be called twice and later operations fail with `DATABASE_CLOSED`.
7. Verify browser and Node adapters return equivalent IDs and ranking for the exact-search fixture, within an explicitly defined floating-point tolerance.
