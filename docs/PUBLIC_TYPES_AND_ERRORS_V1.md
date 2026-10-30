# WeiSQL V1 公共 TypeScript 类型与错误契约

- 状态：Manifest、资源层和精确搜索相关类型已实现；SQL/ANN Adapter 类型仍需真实实现验证
- 适用包：`@weisql/sdk`

本文记录 V1 公共边界，避免 Builder、Runtime 和 Adapter 各自创建同义但不兼容的类型或错误码。具体导出以 `packages/sdk/src/index.ts` 为准。

## 1. Manifest 公共类型

```ts
interface FileDescriptor {
  path: string;
  bytes: number;
  sha256: string;
}

interface TableDescriptor {
  name: string;
  file: FileDescriptor;
  format: "parquet";
  columns: ColumnDescriptor[];
  primaryKey: string[];
}

interface VectorCollectionDescriptor {
  name: string;
  tableName: string;
  idColumn: string;
  count: number;
  dimension: number;
  metric: "cosine" | "l2" | "ip";
  encoding: "f32-le-row-major";
  data: FileDescriptor;
  idMap: IdMapDescriptor;
  index?: {
    engine: string;
    version: string;
    file: FileDescriptor;
  };
}

interface WeiSQLManifest {
  format: "weisql";
  formatVersion: "1.0.0";
  datasetId: string;
  tables: TableDescriptor[];
  vectorCollections: VectorCollectionDescriptor[];
  metadata?: ManifestMetadata;
}
```

`sha256` 在 V1 文件描述符中是必填字段，不是可选提示。外部 JSON 必须由 `validateManifest(input: unknown)` 返回经过验证的类型，不能直接断言。

## 2. ResourceReader

```ts
interface ByteRange {
  start: number; // inclusive
  end: number;   // exclusive
}

interface ResourceReader {
  read(path: string, options?: ResourceReadOptions): Promise<Uint8Array>;
  readRange(path: string, range: ByteRange, options?: ResourceReadOptions): Promise<Uint8Array>;
  stat(path: string, options?: ResourceReadOptions): Promise<ResourceMetadata>;
  close(): Promise<void>;
}
```

Range 采用 `[start,end)`。空范围返回空数组且不触发 I/O。Reader 不得返回超过范围的数据，短读必须明确失败。

## 3. 精确搜索内部公共基线

```ts
interface ExactVectorHit {
  row: number;
  id: string | number;
  distance: number;
}

interface ExactSearchOptions {
  topK: number;
  metric: "cosine" | "l2" | "ip";
  blockSize?: number;
  signal?: AbortSignal;
}
```

`exactVectorSearch()` 是正确性基线：完整扫描集合、最大堆维护 Top-K、最终批量映射 ID。距离相同时按 `row` 升序。空集合返回 `[]` 且不读取资源。

## 4. SDK 向量结果与 exact/ANN 区分

V1 公共 `db.vector.search()` 当前返回 `VectorHit[]` 契约。调用方必须能够辨别后端和是否精确：

- 精确实现通过能力声明 `exactSearch: true`；
- ANN 实现不得声明精确；
- 索引缺失时只有显式配置允许精确回退；
- 回退或后端选择必须进入安全诊断信息；
- 不得仅因为返回 Top-K 就暗示结果是精确最近邻。

在真实 Adapter 接入前，不冻结新的 `VectorSearchResult` 包装对象，以免仅凭草案破坏现有数组 API。若未来需要顶层 `exact`、候选数或 Recall 诊断，应通过 SDK 次版本和兼容迁移引入。

过滤条件继续使用受控标量对象；V1 不接受任意 SQL 字符串作为向量过滤表达式。

## 5. 稳定错误对象

```ts
class WeiSQLError extends Error {
  readonly code: WeiSQLErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;
}
```

V1 已使用的错误码：

| 错误码 | 语义 |
| --- | --- |
| `MANIFEST_INVALID` | JSON 结构、字段、引用或声明语义错误 |
| `FORMAT_VERSION_UNSUPPORTED` | Manifest 版本不受支持 |
| `PATH_INVALID` | 资源路径或解析结果越界 |
| `INVALID_ARGUMENT` | 调用参数非法或超过 API 边界 |
| `RESOURCE_NOT_FOUND` | 声明资源不存在或 HTTP 404 |
| `RESOURCE_READ_FAILED` | 网络、文件或流读取失败 |
| `RESOURCE_INTEGRITY_FAILED` | 长度、摘要、偏移、JSONL 或数据内容不一致 |
| `CORS_OR_RANGE_UNSUPPORTED` | 跨域或 Range 能力不满足读取方式 |
| `INVALID_RANGE_RESPONSE` | Range 不可满足或响应范围无效 |
| `SQL_UNSUPPORTED` | SQL/方言/操作在当前 Adapter 不可用 |
| `VECTOR_DIMENSION_MISMATCH` | 查询和集合维度不一致 |
| `VECTOR_INVALID_VALUE` | NaN、Infinity、Cosine 零向量或非法 Top-K |
| `INDEX_NOT_FOUND` | 向量集合或可用索引不存在，且未允许回退 |
| `DATABASE_CLOSED` | 关闭后继续操作 |
| `QUERY_CANCELLED` | 调用已取消 |
| `INTERNAL_ERROR` | 无法归类的内部故障 |

不再引入 `INVALID_MANIFEST`、`INVALID_PATH`、`FILE_SIZE_MISMATCH`、`HASH_MISMATCH`、`CANCELLED` 等同义代码。大小与哈希不符统一为 `RESOURCE_INTEGRITY_FAILED`，取消统一为 `QUERY_CANCELLED`。

## 6. 错误映射原则

- 网络失败不映射为 Manifest 错误；
- 取消不映射为查询或引擎失败；
- 引擎缺失或功能不支持不得返回空成功结果；
- 完整性失败停止使用资源，不通过无界重试掩盖；
- 暂时网络故障如需重试，必须有限次数、支持取消并采用退避；
- `details` 可以包含字段路径、HTTP 状态、集合名和安全诊断阶段；
- `details` 不得包含密钥、Cookie、Authorization、签名 URL 查询参数、完整查询参数、向量内容或私有绝对路径。

## 7. 兼容性规则

错误码是公共契约：

- 现有错误码的含义不得静默改变；
- 新增错误码需要文档、测试和调用方未知码回退策略；
- 依赖专用异常必须在 Adapter 边界转换；
- 浏览器与 Node 对同一输入应返回相同高层错误码，底层 `details` 可以不同；
- 错误消息用于人类诊断，程序逻辑只依赖 `code` 和文档化字段。

## 8. 自动化验收

- 每个公共错误码至少有一个触发测试；
- Manifest 结构、引用、路径与版本错误保持稳定分类；
- HTTP 404、200 忽略 Range、416、错误 `Content-Range`、短响应和取消分别测试；
- 向量维度、非有限值、零向量、Top-K、空集合分别测试；
- 关闭后的 Database、Reader 和 ID Map Reader 分别测试；
- 后续 SQL/ANN Adapter 必须运行共享错误映射契约测试。

