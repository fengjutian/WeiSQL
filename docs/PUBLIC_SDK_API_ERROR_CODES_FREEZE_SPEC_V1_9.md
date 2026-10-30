# WeiSQL AI 公共 SDK API 与错误码正式冻结规范 V1.9

文档编号：WSAI-API-001 · 版本：V1.9 · 状态：设计冻结候选 · 适用范围：TypeScript 公共 SDK、Node.js Runtime、Browser Runtime

本规范承接 V1.8《数据包格式与 Manifest 正式规范》，正式定义 WeiSQL AI 的公共 API、类型系统、错误码、资源生命周期和兼容性规则。

本次目标是冻结公共契约，而不是宣称 SDK 已经实现。 具体适配器能力、性能表现和跨运行环境兼容性仍须通过实现与测试验证。

## 一、冻结原则

公共 API 不依赖底层引擎

调用方不需要了解 DuckDB、DuckDB-Wasm、USearch 或未来 Rust/WASM 内部类型。

Node.js 与浏览器共享同一套契约

SQL、向量搜索、混合检索、错误语义和生命周期保持一致；底层能力通过 `capabilities` 暴露。

V1 只读优先

SDK 提供查询能力，不提供数据包在线写入、事务、多用户同步和数据变更 API。

错误可识别、可测试、可恢复

错误码稳定，错误类别明确；不能支持的功能必须明确失败，不允许静默降级成看似成功的结果。

### 1.1 冻结范围

| 范围      | V1.9 决策                     |
| ------- | --------------------------- |
| SDK 语言  | TypeScript                  |
| 数据包格式   | Manifest V1.8 契约            |
| SQL 引擎  | DuckDB / DuckDB-Wasm 适配器    |
| 向量搜索    | Exact Search 基线；ANN 通过适配器提供 |
| 混合检索    | SQL 过滤与向量检索编排               |
| 执行环境    | Node.js、浏览器                 |
| 数据修改    | 不支持                         |
| 错误识别    | 稳定的 `WeiSQLErrorCode`       |
| 取消      | 支持 `AbortSignal` 的 API 允许取消 |
| 流式查询    | 可选能力，不保证所有适配器支持             |
| 发布者身份验证 | V1 不内置完整签名体系                |

## 二、公共包与导出结构

建议使用 pnpm Monorepo 管理内部包，但对外提供清晰的公共入口。

```
@weisql-ai/core
@weisql-ai/manifest
@weisql-ai/runtime
@weisql-ai/node
@weisql-ai/browser
@weisql-ai/builder
```

### 2.1 包职责

| 包名                    | 对外职责                      | 是否属于运行时必需依赖 |
| --------------------- | ------------------------- | ----------- |
| `@weisql-ai/core`     | 公共类型、错误码、距离定义             | 是           |
| `@weisql-ai/manifest` | Manifest 解析、结构校验          | 是           |
| `@weisql-ai/runtime`  | 数据库生命周期、查询编排              | 是           |
| `@weisql-ai/node`     | Node.js 文件读取与运行环境适配       | Node 环境     |
| `@weisql-ai/browser`  | HTTP Range、浏览器资源与 WASM 适配 | 浏览器环境       |
| `@weisql-ai/builder`  | 构建、验证和发布数据包               | 仅构建阶段       |

这些包名是建议冻结的发布名称，实际发布前还需检查 npm 命名空间可用性。

### 2.2 导出边界

推荐入口：

```
// Node.js
import { open } from "@weisql-ai/node";

// Browser
import { open } from "@weisql-ai/browser";

// Shared types
import type {
  OpenOptions,
  WeiSQLDatabase,
  SQLQueryOptions,
  VectorSearchRequest,
  HybridSearchRequest,
  WeiSQLCapabilities,
} from "@weisql-ai/core";
```

规则：

1. `@weisql-ai/core` 不导入 Node.js 原生模块、浏览器 DOM 或具体数据库引擎。
2. Node.js 与浏览器入口分别负责初始化对应环境。
3. 引擎专用类、WASM 模块实例和私有适配器不属于公共 API。
4. 不允许公共类型直接引用 DuckDB 或 USearch 的内部类型。
5. Builder 的构建依赖不应被普通 Runtime 用户无意加载。

## 三、公共类型系统

建议将以下类型作为公共契约的基础。

### 3.1 基础类型

```
export type DatasetId = string;
export type TableName = string;
export type VectorCollectionName = string;
export type RowId = string | number;

export type DistanceMetric =
  | "cosine"
  | "l2"
  | "ip";

export type JsonPrimitive =
  | string
  | number
  | boolean
  | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
```

公共数据类型不应包含函数、循环引用或引擎对象。

对于 JSON 数值，Manifest 与过滤条件解析阶段必须拒绝 `NaN`、`Infinity` 和 `-Infinity`。JavaScript 中 `number` 本身不能表达 JSON 对这些值的合法支持。

### 3.2 运行环境类型

```
export type RuntimeEnvironment =
  | "node"
  | "browser";
```

环境类型仅用于能力说明和诊断，不允许调用方通过伪造环境字符串改变实际运行时行为。

## 四、数据库打开 API

### 4.1 `OpenOptions`

```
export interface OpenOptions {
  /**
   * 数据包目录、Manifest 文件或浏览器可访问的包 URL。
   * 具体形式由对应环境入口定义。
   */
  source: string;

  /**
   * Manifest 和数据文件完整性验证策略。
   */
  integrity?: "none" | "metadata" | "full";

  /**
   * 默认查询取消与资源操作的超时时间，单位 ms。
   */
  timeoutMs?: number;

  /**
   * 允许调用方主动取消初始化。
   */
  signal?: AbortSignal;

  /**
   * 是否在打开时验证所需的向量索引。
   */
  verifyIndexes?: boolean;
}
```

`source` 在 Node.js 中可以表示本地路径；在浏览器中通常是 HTTP(S) URL。各环境入口必须分别定义合法形式。

#### 完整性策略语义

| 值          | 冻结语义                                            |
| ---------- | ----------------------------------------------- |
| `none`     | 跳过数据文件哈希校验，但仍须进行安全的 Manifest 结构和路径校验            |
| `metadata` | 校验 Manifest 引用、文件大小等元数据；不代表全部数据文件已完成 SHA-256 校验 |
| `full`     | 对所有声明需要完整性校验的文件进行实际字节级 SHA-256 验证               |

默认值建议：`metadata`。 如果业务要求启动时确认整个数据包完整，应显式使用 `full`。如果底层资源读取器不能完成指定验证，必须返回错误，不可声称验证通过。

`timeoutMs` 必须是有限正整数。超时不代表底层引擎一定能立即终止所有原生任务；取消结果和残留资源须由适配器测试确认。

### 4.2 打开数据库

```
export async function open(
  options: OpenOptions,
): Promise<WeiSQLDatabase>;
```

行为要求：

1. 校验选项与 Manifest。
2. 检查数据包格式版本兼容性。
3. 初始化 SQL 和向量适配器。
4. 校验请求所依赖的资源。
5. 返回处于 `READY` 状态的数据库实例。
6. 任一步骤失败，释放已分配的临时资源并抛出标准错误。

`open()` 成功不意味着每一个可选能力都已启用。调用方必须查询 `capabilities`，不能仅凭数据库已打开就推断向量索引或全文搜索可用。

## 五、数据库实例接口

这是 V1 SDK 的核心公共接口。

```
export interface WeiSQLDatabase {
  readonly dataset: DatasetInfo;
  readonly capabilities: WeiSQLCapabilities;

  sql(
    query: string,
    options?: SQLQueryOptions,
  ): Promise<SQLQueryResult>;

  queryPage(
    query: string,
    options?: SQLPageOptions,
  ): Promise<SQLQueryPage>;

  sqlStream(
    query: string,
    options?: SQLStreamOptions,
  ): AsyncIterable<SQLRow>;

  readonly vector: VectorSearchClient;

  readonly hybrid: HybridSearchClient;

  close(): Promise<void>;
}
```

说明：

- `dataset` 返回只读的数据集元信息。
- `capabilities` 表示当前数据包和当前 Runtime 组合后实际可用的能力。
- `sql()` 返回完整查询结果。
- `queryPage()` 用于显式分页。
- `sqlStream()` 用于支持流式读取的适配器。
- `vector` 与 `hybrid` 提供独立检索接口。
- `close()` 释放数据库实例拥有的资源。

如果底层引擎不支持流式查询，`sqlStream()` 应返回 `CAPABILITY_UNAVAILABLE`，不能先将全部结果载入内存，再假称实现了流式读取。

### 5.1 数据集信息

```
export interface DatasetInfo {
  readonly id: DatasetId;
  readonly version: string;
  readonly formatVersion: string;
  readonly tables: readonly TableInfo[];
  readonly vectorCollections:
    readonly VectorCollectionInfo[];
}

export interface TableInfo {
  readonly name: TableName;
  readonly rowCount?: number;
  readonly columns: readonly ColumnInfo[];
}

export interface ColumnInfo {
  readonly name: string;
  readonly type: string;
  readonly nullable?: boolean;
}

export interface VectorCollectionInfo {
  readonly name: VectorCollectionName;
  readonly dimension: number;
  readonly count: number;
  readonly metric: DistanceMetric;
}
```

`version` 是数据集发布版本；`formatVersion` 是数据包格式版本。两者不可混用。

## 六、SQL 查询契约

### 6.1 查询选项

```
export interface SQLQueryOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly parameters?: readonly SQLParameter[];
}

export type SQLParameter =
  | string
  | number
  | boolean
  | null
  | Uint8Array
  | Date;
```

参数绑定优先于字符串拼接。不同 SQL 适配器必须统一参数类型转换和不支持类型的报错语义。

`timeoutMs` 和 `signal` 可同时提供：先触发的取消条件生效。超时应使用 `TIMEOUT` 错误码，用户主动取消使用 `CANCELLED`。

### 6.2 查询结果

```
export interface SQLQueryResult {
  readonly columns: readonly SQLColumn[];
  readonly rows: readonly SQLRow[];
  readonly rowCount: number;
  readonly elapsedMs?: number;
}

export interface SQLColumn {
  readonly name: string;
  readonly type?: string;
}

export type SQLRow =
  Readonly<Record<string, unknown>>;
```

冻结规则：

- `rowCount` 为本次结果实际返回的行数，不代表底表总行数。
- `elapsedMs` 是可选诊断信息，不作为跨环境性能比较的严格标准。
- 不暴露引擎的原生 RecordBatch、Arrow 内部对象或数据库连接对象。
- `rows` 是只读类型约束；实现不应向调用方暴露可破坏内部状态的共享可变对象。
- SQL 的写操作是否被禁止必须通过适配器和语句策略明确实施，不能仅靠文档声明。

### 6.3 分页

```
export interface SQLPageOptions
  extends SQLQueryOptions {
  readonly limit: number;
  readonly offset?: number;
}

export interface SQLQueryPage {
  readonly columns: readonly SQLColumn[];
  readonly rows: readonly SQLRow[];
  readonly limit: number;
  readonly offset: number;
  readonly hasMore: boolean;
}
```

限制：

- `limit` 必须为正整数，并且不超过 Runtime 配置的最大页大小。
- `offset` 必须为非负整数。
- 如果 SQL 自身已包含分页，适配器不得悄悄追加另一套分页语义。
- 没有确定排序的 SQL 不能保证跨请求分页稳定；需要稳定翻页时，调用方应指定确定的 `ORDER BY`。
- `hasMore` 只有在实现确实能够判断是否存在下一页时才能提供可信值；不能仅因当前页满额就断言有更多结果。

## 七、向量搜索公共 API

### 7.1 请求类型

```
export interface VectorSearchRequest {
  readonly collection: VectorCollectionName;

  /**
   * 必须与集合的向量维度一致。
   */
  readonly vector: readonly number[];

  readonly topK?: number;

  /**
   * 默认使用 Manifest 声明的 metric。
   */
  readonly metric?: DistanceMetric;

  /**
   * 允许后端支持时调节 ANN 搜索精度。
   */
  readonly efSearch?: number;

  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}
```

冻结规则：

1. `topK` 默认值为 `10`，但不得超过 Runtime 的配置上限。
2. `metric` 未提供时，使用集合在 Manifest 中声明的度量。
3. 显式 `metric` 与集合度量不一致时，首版默认拒绝，除非实现明确支持按请求动态计算距离且其语义经过测试。
4. 向量长度必须与 `dimension` 一致。
5. 所有分量必须是有限数值。
6. cosine 搜索拒绝零向量。
7. ANN 参数仅在对应后端支持时生效；不支持时返回明确错误或按能力策略拒绝，不能静默忽略。
8. 调用方不得假定所有向量搜索都是 ANN 或都是精确搜索。

### 7.2 结果类型

```
export interface VectorSearchResult {
  readonly id: RowId;
  readonly rowId: number;
  readonly distance: number;
  readonly score: number;
  readonly metric: DistanceMetric;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface VectorSearchResponse {
  readonly results: readonly VectorSearchResult[];
  readonly metric: DistanceMetric;
  readonly exact: boolean;
  readonly elapsedMs?: number;
}

export interface VectorSearchClient {
  search(
    request: VectorSearchRequest,
  ): Promise<VectorSearchResponse>;
}
```

字段语义：

| 字段         | 含义                        |
| ---------- | ------------------------- |
| `id`       | 数据集公开的业务 ID               |
| `rowId`    | 向量在对应集合中的内部行号             |
| `distance` | 统一的距离值，越小越相近              |
| `score`    | 用于显示或排序的分数，不替代 `distance` |
| `metric`   | 本次实际使用的距离度量               |
| `exact`    | 是否保证返回集合范围内全局精确 Top-K     |

分数转换规则：

| Metric   | `distance`                              | `score`         |
| -------- | --------------------------------------- | --------------- |
| `cosine` | \\(1-\operatorname{cosineSimilarity}\\) | \\(-distance\\) |
| `l2`     | 欧氏距离                                    | \\(-distance\\) |
| `ip`     | 负内积                                     | \\(-distance\\) |

统一采用 `score = -distance`，避免不同度量下“分数越大越好”的约定产生歧义。若后续需要归一化显示分数，应作为独立展示 API，而不是修改本契约。

结果排序：

1. `distance` 升序。
2. 距离相同时，按 `rowId` 升序。
3. 相同输入和相同精确计算路径应得到确定排序。
4. 不同 ANN 后端的结果集可能不同，除非通过同一基准和 Recall\@K 门槛验证。

`exact: true` 仅在算法能够证明已搜索完整候选空间并返回全局精确 Top-K 时使用。对 ANN 候选集进行精确重排，不等于全局精确搜索。

## 八、结构化过滤与混合检索

### 8.1 FilterExpression

V1 使用结构化过滤 AST，不将任意用户字符串直接拼接为 SQL。

```
export type FilterExpression =
  | {
      readonly op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
      readonly field: string;
      readonly value: JsonPrimitive;
    }
  | {
      readonly op: "in";
      readonly field: string;
      readonly values: readonly JsonPrimitive[];
    }
  | {
      readonly op: "and" | "or";
      readonly expressions: readonly FilterExpression[];
    }
  | {
      readonly op: "not";
      readonly expression: FilterExpression;
    };
```

安全要求：

- `field` 必须经过 Schema 白名单校验。
- 字段名不可直接当作已验证 SQL 标识符。
- 值必须参数化绑定。
- `in` 的数组大小、表达式深度和节点总数应受配置限制。
- 对类型不匹配、未知字段和空表达式必须给出明确错误。
- `null` 比较的语义应在适配器层统一，不能把 SQL 三值逻辑悄悄替换为 JavaScript 布尔逻辑。

### 8.2 混合检索 API

```
export interface HybridSearchRequest
  extends VectorSearchRequest {
  readonly filter?: FilterExpression;
  readonly textQuery?: string;
  readonly vectorWeight?: number;
  readonly textWeight?: number;
}

export interface HybridSearchResult
  extends VectorSearchResult {
  readonly vectorRank?: number;
  readonly textRank?: number;
  readonly fusedScore?: number;
}

export interface HybridSearchResponse {
  readonly results: readonly HybridSearchResult[];
  readonly strategy:
    | "vector-first"
    | "filter-first"
    | "rank-fusion";
  readonly exact: boolean;
}

export interface HybridSearchClient {
  search(
    request: HybridSearchRequest,
  ): Promise<HybridSearchResponse>;
}
```

冻结边界：

- `filter` 是结构化过滤。
- `textQuery` 只有在数据包声明全文检索能力且 Runtime 具备对应实现时才能使用。
- V1 不承诺某种固定的全文算法或固定的 RRF 参数。
- `vectorWeight` 与 `textWeight` 仅在后端声明支持对应融合策略时可用；否则拒绝请求。
- `strategy` 必须反映实际执行路径。
- 如果先取有限向量候选再过滤，可能返回少于 `topK` 条记录，且不保证过滤后全局精确 Top-K。
- 如果系统切换策略，响应必须反映实际使用的策略；不能谎报 `exact: true`。

## 九、Capabilities 能力协商

```
export interface WeiSQLCapabilities {
  readonly environment: RuntimeEnvironment;

  readonly sql: {
    readonly available: boolean;
    readonly parameterBinding: boolean;
    readonly streaming: boolean;
    readonly cancellation: boolean;
  };

  readonly vector: {
    readonly available: boolean;
    readonly exactSearch: boolean;
    readonly annSearch: boolean;
    readonly metrics: readonly DistanceMetric[];
  };

  readonly hybrid: {
    readonly available: boolean;
    readonly structuredFilter: boolean;
    readonly fullText: boolean;
    readonly rankFusion: boolean;
  };

  readonly resources: {
    readonly rangeRead: boolean;
    readonly integrityVerification: boolean;
  };
}
```

`capabilities` 必须是实际运行时能力和数据包声明能力的交集，而不是静态写死的理想功能列表。

```
有效能力 = 数据包声明能力 ∩ Runtime 实际能力
```

例如，数据包存在向量数据，但当前 Runtime 没有可用的向量适配器，则 `vector.available` 必须为 `false`。

能力声明与调用结果必须一致：若某能力声明可用，但调用时由于环境限制无法执行，应返回明确错误并纳入一致性测试。

## 十、错误对象与稳定错误码

### 10.1 错误结构

```
export type WeiSQLErrorCode =
  | "INVALID_ARGUMENT"
  | "INVALID_MANIFEST"
  | "UNSUPPORTED_FORMAT_VERSION"
  | "UNSUPPORTED_CAPABILITY"
  | "PACKAGE_NOT_FOUND"
  | "RESOURCE_NOT_FOUND"
  | "PATH_INVALID"
  | "PATH_OUTSIDE_ROOT"
  | "RESOURCE_READ_FAILED"
  | "RANGE_UNSUPPORTED"
  | "INTEGRITY_CHECK_FAILED"
  | "SCHEMA_MISMATCH"
  | "QUERY_INVALID"
  | "QUERY_EXECUTION_FAILED"
  | "VECTOR_DIMENSION_MISMATCH"
  | "VECTOR_VALUE_INVALID"
  | "VECTOR_METRIC_MISMATCH"
  | "VECTOR_INDEX_INVALID"
  | "FILTER_INVALID"
  | "CANCELLED"
  | "TIMEOUT"
  | "RESOURCE_CLOSED"
  | "RESOURCE_BUSY"
  | "MEMORY_LIMIT_EXCEEDED"
  | "INTERNAL_ERROR";

export type WeiSQLErrorCategory =
  | "validation"
  | "compatibility"
  | "capability"
  | "resource"
  | "integrity"
  | "query"
  | "vector"
  | "lifecycle"
  | "timeout"
  | "internal";

export interface WeiSQLErrorDetails {
  readonly datasetId?: string;
  readonly resourcePath?: string;
  readonly operation?: string;
  readonly retryable?: boolean;
  readonly causeCode?: string;
  readonly [key: string]: JsonValue | undefined;
}

export class WeiSQLError extends Error {
  readonly name = "WeiSQLError";

  constructor(
    readonly code: WeiSQLErrorCode,
    message: string,
    readonly category: WeiSQLErrorCategory,
    readonly details?: WeiSQLErrorDetails,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
```

注意：`Error` 构造器的 `cause` 选项需要与 TypeScript 的 `target`、`lib` 和运行时支持保持一致；工程实现应明确配置。若目标环境不能可靠支持原生 `cause`，可以在内部兼容层保存原因，但不得改变公共错误码。

### 10.2 错误码与处理建议

| 错误码                          | 类别            | 默认可重试    | 处理建议                 |
| ---------------------------- | ------------- | -------- | -------------------- |
| `INVALID_ARGUMENT`           | validation    | 否        | 修正参数                 |
| `INVALID_MANIFEST`           | validation    | 否        | 修复 Manifest          |
| `UNSUPPORTED_FORMAT_VERSION` | compatibility | 否        | 升级 SDK 或转换数据包        |
| `UNSUPPORTED_CAPABILITY`     | capability    | 否        | 换用支持该能力的 Runtime     |
| `PACKAGE_NOT_FOUND`          | resource      | 视环境而定    | 检查路径或 URL            |
| `RESOURCE_NOT_FOUND`         | resource      | 通常否      | 检查文件清单和部署            |
| `PATH_INVALID`               | validation    | 否        | 修正资源路径               |
| `PATH_OUTSIDE_ROOT`          | validation    | 否        | 拒绝不安全路径              |
| `RESOURCE_READ_FAILED`       | resource      | 可能       | 检查网络、权限和存储           |
| `RANGE_UNSUPPORTED`          | resource      | 视服务器配置而定 | 检查 HTTP Range 支持     |
| `INTEGRITY_CHECK_FAILED`     | integrity     | 否        | 重新发布或恢复可信数据包         |
| `SCHEMA_MISMATCH`            | validation    | 否        | 检查数据与 Manifest       |
| `QUERY_INVALID`              | query         | 否        | 修正 SQL               |
| `QUERY_EXECUTION_FAILED`     | query         | 视原因而定    | 查看受控诊断信息             |
| `VECTOR_DIMENSION_MISMATCH`  | vector        | 否        | 使用正确维度               |
| `VECTOR_VALUE_INVALID`       | vector        | 否        | 检查 NaN、Infinity、零向量等 |
| `VECTOR_METRIC_MISMATCH`     | vector        | 否        | 统一集合和请求度量            |
| `VECTOR_INDEX_INVALID`       | integrity     | 通常否      | 重建索引或恢复正确版本          |
| `FILTER_INVALID`             | validation    | 否        | 修正过滤 AST             |
| `CANCELLED`                  | lifecycle     | 不适用      | 按业务需要重新提交            |
| `TIMEOUT`                    | timeout       | 可能       | 调整超时或优化查询            |
| `RESOURCE_CLOSED`            | lifecycle     | 否        | 创建新实例                |
| `RESOURCE_BUSY`              | lifecycle     | 可能       | 等待资源释放后重试            |
| `MEMORY_LIMIT_EXCEEDED`      | resource      | 可能       | 降低批量、Top-K 或并发       |
| `INTERNAL_ERROR`             | internal      | 未知       | 记录诊断信息并排查            |

“可重试”是默认建议，不是保证。网络读取错误可能可重试，但哈希不匹配不能盲目重试；超时是否可重试取决于操作的幂等性。

### 10.3 错误码映射规则

适配器必须把底层错误转换为公共错误：

```
底层引擎错误
    ↓
适配器分类
    ↓
WeiSQLError
    ↓
公共 API 抛出
```

要求：

1. 调用方不得依赖底层错误消息的具体文本。
2. 错误码必须稳定；文案允许修正。
3. 不得把取消、超时、完整性失败统一包装成 `INTERNAL_ERROR`。
4. 资源路径、SQL 参数和内部异常可能包含敏感信息；生产日志必须支持脱敏。
5. 对外消息不能暴露服务器绝对路径、凭证或内部部署细节。
6. 未知异常映射为 `INTERNAL_ERROR`，同时保留内部 `cause` 供受控诊断使用。

## 十一、资源生命周期与取消语义

### 11.1 状态机

CREATED

OPENING

READY

CLOSING

CLOSED

初始化失败进入 FAILED；关闭操作不可逆，关闭后的实例不能重新打开。

### 11.2 `close()` 规则

- `close()` 幂等；重复调用应安全完成。
- 从进入 `CLOSING` 起，不接受新的查询。
- 尽可能取消在途请求并释放资源。
- `close()` 应等待 Runtime 自身可以等待的清理任务结束。
- 关闭期间已启动的操作可能返回 `CANCELLED` 或 `RESOURCE_CLOSED`；具体映射必须在适配器一致性测试中冻结。
- 已关闭实例不能复用；需要重新打开时重新调用 `open()`。
- 对于无法中止的原生任务，适配器应明确记录其取消限制，不得声称所有任务都能立即终止。

### 11.3 `AbortSignal` 规则

所有声明支持 `signal` 的方法都必须：

1. 在执行前检查是否已取消。
2. 在支持取消的资源读取、查询和等待阶段监听取消信号。
3. 取消时尽可能停止后续工作。
4. 清理监听器和临时资源。
5. 将用户取消统一映射为 `CANCELLED`。
6. 将内部超时映射为 `TIMEOUT`，而不是混为一类。

## 十二、版本兼容和弃用政策

### 12.1 API 版本策略

采用语义化版本：

- PATCH：修复实现错误，不改变公共契约。
- MINOR：增加向后兼容的公共能力。
- MAJOR：删除、重命名或改变既有公共行为。

公共 API 只有在完成类型检查、契约测试和变更审查后，才能认定为冻结。

### 12.2 不允许的静默变化

以下变化应视为破坏性变更，不能混入普通补丁：

- 改变距离的定义或排序规则。
- 改变默认 `topK`。
- 改变 `exact` 的保证范围。
- 改变错误码的含义。
- 把原本必定失败的操作改成静默降级。
- 改变过滤逻辑中的 NULL 语义。
- 改变 `close()` 后的实例行为。
- 改变 Manifest 字段的含义或兼容性判断方式。

### 12.3 Manifest 与 SDK 版本独立

`package.json` 的 SDK 版本与 Manifest `formatVersion` 必须分开管理。SDK 的次版本升级不应自动改变数据包格式；数据包格式升级也不应被误认为 SDK 版本升级。

## 十三、参考调用示例

### 13.1 打开数据包并执行 SQL

```
import { open } from "@weisql-ai/node";

const db = await open({
  source: "./dist/weisql-package",
  integrity: "full",
});

try {
  const result = await db.sql(
    "SELECT id, title FROM documents ORDER BY id LIMIT ?",
    {
      parameters: [20],
    },
  );

  console.log(result.columns);
  console.log(result.rows);
} finally {
  await db.close();
}
```

该示例要求 Node.js 入口支持本地数据包路径，并且 SQL 适配器支持参数绑定。当前示例定义了目标调用形式，并不代表已有代码已运行验证。

### 13.2 向量搜索

```
const response = await db.vector.search({
  collection: "document_embeddings",
  vector: queryEmbedding,
  topK: 10,
});

for (const result of response.results) {
  console.log({
    id: result.id,
    distance: result.distance,
    score: result.score,
  });
}
```

`queryEmbedding` 的维度必须与集合一致，且所有分量必须为有限数值。

### 13.3 混合检索

```
const response = await db.hybrid.search({
  collection: "document_embeddings",
  vector: queryEmbedding,
  topK: 10,
  filter: {
    op: "eq",
    field: "status",
    value: "published",
  },
});

console.log(response.strategy);
console.log(response.results);
```

这里的 `status` 必须存在于可过滤字段的 Schema 白名单中。过滤语法不允许调用方直接传入 SQL 片段。

### 13.4 标准错误处理

```
import { WeiSQLError } from "@weisql-ai/core";

try {
  await db.vector.search({
    collection: "document_embeddings",
    vector: queryEmbedding,
    topK: 10,
  });
} catch (error) {
  if (error instanceof WeiSQLError) {
    switch (error.code) {
      case "VECTOR_DIMENSION_MISMATCH":
        // 修正查询向量维度
        break;

      case "UNSUPPORTED_CAPABILITY":
        // 提示当前 Runtime 不支持该能力
        break;

      case "CANCELLED":
        // 按业务策略处理取消
        break;

      default:
        // 使用稳定错误码进行诊断
        break;
    }
  } else {
    // 兼容第三方代码或非标准异常
    throw error;
  }
}
```

## 十四、V1.9 API 冻结验收清单

## 验收进度

0/10

公共类型

所有公共类型位于稳定入口，不泄露引擎私有类型。

环境入口

Node.js 和 Browser 入口各自构建，依赖边界清晰。

Manifest 兼容

V1.8 Manifest 解析、版本拒绝和引用校验通过。

SQL 语义

参数绑定、分页、流式能力和只读策略具有契约测试。

向量一致性

cosine、L2、IP、维度校验、稳定排序与 exact 标记通过测试。

混合检索

过滤白名单、策略声明、Top-K 语义和融合能力正确。

错误码

错误映射稳定，取消、超时、资源损坏和能力缺失不混淆。

生命周期

close 幂等、关闭后拒绝操作、取消和资源清理通过测试。

跨环境

同一测试向量集在 Node.js 与 Browser 得到约定的一致结果。

发布检查

类型声明、导出路径、包依赖、API 变更检查和文档示例通过 CI。

重置清单复制验收清单

这是供评审使用的本地清单，不会自动检查仓库或代表测试已通过。

## 十五、冻结前仍需解决的决策

| 决策项              | 当前建议       | 冻结前必须完成                         |
| ---------------- | ---------- | ------------------------------- |
| SQL 只读防护         | 默认拒绝写语句    | 确定 DuckDB 与 DuckDB-Wasm 的统一执行策略 |
| `sqlStream()`    | 可选能力       | 明确迭代器中途退出时的清理行为                 |
| `exact`          | 严格语义       | 证明每个适配器的 Top-K 保证               |
| `metadata` 完整性级别 | 默认值建议      | 统一“元数据验证”包含的精确检查项               |
| 混合检索             | 结构化过滤优先    | 冻结过滤顺序、融合算法及权重行为                |
| 浏览器资源读取          | HTTP Range | 在目标托管环境验证 Range、CORS、缓存         |
| 错误扩展             | 稳定错误码      | 冻结错误码新增、弃用和版本策略                 |

## 十六、正式冻结标准

V1.9 进入正式冻结，需要满足：

1. 将本规范转为可编译的 TypeScript 声明文件。
2. 为所有公共 API 建立契约测试。
3. 对 Node.js 与浏览器分别验证入口、资源读取和生命周期。
4. 为所有错误码建立最小触发测试与适配器映射测试。
5. 将 API 示例纳入 CI，避免文档示例与真实实现脱节。
6. 建立 API 变更检查，禁止未经评审的破坏性修改。
7. 对尚未实现的能力明确标记，不将设计意图误认为可用功能。

结论：V1.9 定义的是 WeiSQL AI 的公共 SDK 契约。 只有完成上述验收后，才能将其状态从“设计冻结候选”升级为“正式冻结”。

下一份建议文档是《WeiSQL AI API 契约测试与兼容性自动化实施规范 V2.0》，把本规范中的每一条规则转化为可执行测试、CI 检查和发布阻断条件。

