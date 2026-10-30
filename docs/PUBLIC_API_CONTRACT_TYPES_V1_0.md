# WeiSQL AI — API Contract V1.0

规范草案

TypeScript

只读 Runtime

Browser + Node.js

适用范围：公开 SDK、SQL 查询、向量搜索、混合检索、资源生命周期和错误处理。

### 与当前仓库的差异

本文是**设计草案**，包结构与命名未按本文落地（本文用 `@weisql/runtime`，实际是 `@weisql/sdk`）。当前公共 API 与错误码以 [`PUBLIC_TYPES_AND_ERRORS_V1.md`](PUBLIC_TYPES_AND_ERRORS_V1.md) 和 [`SDK_API_CONTRACT_V1.md`](SDK_API_CONTRACT_V1.md) 为准——那两份已由实现与测试验证。冲突时以它们为准。

## 一、公开 API 总览

应用开发者只需要接触 WeiSQL SDK，不需要了解 DuckDB、DuckDB-Wasm、USearch 或 Rust 内部实现。

```
import { open } from "@weisql/runtime";

const db = await open({
  source: "/data/weisql-package/",
});

const result = await db.sql(
  "SELECT id, title FROM documents WHERE category = ?",
  ["biology"],
);

const hits = await db.vector.search({
  collection: "document_embeddings",
  vector: [0.12, 0.34, 0.56],
  topK: 10,
});

await db.close();
```

以上代码用于定义目标 API 形态，`source` 路径、集合名称、字段和向量维度均需与实际数据包匹配；它不是已经运行验证的示例。

### 接口分层

`WeiSQLDatabase`

open / sql / vector / hybrid / capabilities / close

查询层

SQL、参数绑定、结构化过滤、结果规范化

检索层

精确搜索、ANN、全文与混合检索

资源层

Manifest、分块读取、缓存、校验、取消、关闭

Browser Adapter

HTTP / CDN / WASM

Node Adapter

Filesystem / Native

## 二、基础类型定义

建议先将公开类型放在 `packages/core/src/types/`，所有运行时实现共用同一套类型。

### 2.1 错误体系

```
export type WeiSQLErrorCode =
  | "INVALID_MANIFEST"
  | "UNSUPPORTED_FORMAT_VERSION"
  | "INVALID_PATH"
  | "INVALID_REFERENCE"
  | "DUPLICATE_IDENTIFIER"
  | "INVALID_VECTOR_DIMENSION"
  | "INVALID_VECTOR_COUNT"
  | "INVALID_METRIC"
  | "FILE_NOT_FOUND"
  | "FILE_SIZE_MISMATCH"
  | "HASH_MISMATCH"
  | "RANGE_UNSUPPORTED"
  | "RESOURCE_RANGE_INVALID"
  | "RESOURCE_TRUNCATED"
  | "RESOURCE_CLOSED"
  | "NETWORK_ERROR"
  | "CANCELLED"
  | "RESOURCE_LIMIT"
  | "ENGINE_UNAVAILABLE"
  | "ENGINE_ERROR"
  | "INVALID_QUERY"
  | "INVALID_VECTOR"
  | "INTEGRITY_ERROR";

export interface WeiSQLErrorOptions {
  code: WeiSQLErrorCode;
  message: string;
  details?: Readonly<Record<string, unknown>>;
  cause?: unknown;
}

export class WeiSQLError extends Error {
  readonly code: WeiSQLErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(options: WeiSQLErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = "WeiSQLError";
    this.code = options.code;

    if (options.details !== undefined) {
      this.details = options.details;
    }
  }
}
```

规范要求：

- 应用可以通过 `error.code` 稳定判断错误类型。
- `message` 仅用于阅读，不得作为程序分支判断条件。
- `cause` 保留底层错误，公开错误信息不得泄露密钥或不必要的本地敏感路径。
- 用户主动取消统一映射为 `CANCELLED`。
- 关闭后使用实例统一映射为 `RESOURCE_CLOSED`。
- 不得将数据损坏、引擎缺失等错误伪装成空结果。

### 2.2 数据集与运行时能力

```
export interface DatasetInfo {
  id: string;
  formatVersion: string;
  datasetVersion?: string;
}

export interface RuntimeCapabilities {
  environment: "browser" | "node";
  sql: {
    available: boolean;
    engine?: string;
    supportedFeatures: string[];
    parameterBinding: boolean;
  };
  vector: {
    available: boolean;
    metrics: Array<"cosine" | "l2" | "ip">;
    exactSearch: boolean;
    approximateSearch: boolean;
  };
  fullText: {
    available: boolean;
  };
  hybridSearch: {
    available: boolean;
  };
  resource: {
    rangeRead: boolean;
    integrityVerification: boolean;
    maxConcurrentReads: number;
  };
}
```

能力声明必须来自实际加载成功的适配器，而不是静态写死的理想功能。比如没有可用的向量引擎时，`vector.available` 必须为 `false`。

## 三、打开数据包与生命周期

### 3.1 `open()`

```
export interface OpenOptions {
  source: string | URL;
  signal?: AbortSignal;

  resource?: {
    maxCacheBytes?: number;
    maxConcurrentReads?: number;
    maxRangeBytes?: number;
    verifyResourceHashes?: boolean;
  };

  engines?: {
    sql?: "duckdb" | "duckdb-wasm" | "auto";
    vector?: "usearch" | "duckdb-vss" | "exact" | "auto";
  };
}

export interface WeiSQLDatabase {
  readonly dataset: DatasetInfo;

  sql<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    params?: readonly unknown[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;

  readonly vector: VectorSearchAPI;
  readonly hybrid: HybridSearchAPI;

  capabilities(): RuntimeCapabilities;
  close(): Promise<void>;
}

export declare function open(
  options: OpenOptions,
): Promise<WeiSQLDatabase>;
```

这里需要特别明确两个设计点：

1. `source` 表示数据包根目录或可解析的数据包入口，不代表一定可以使用 `file://`、任意 CDN 或任意 URL。具体协议由对应 Reader 实现决定。
2. `close()` 应当幂等；关闭开始后拒绝新操作，并对正在执行的操作采用统一的终止或等待策略。

### 3.2 生命周期状态

CREATED

OPENING

加载 Manifest、校验引用、初始化引擎

READY

接受查询与资源读取

失败

→ FAILED

关闭

→ CLOSING → CLOSED

规范补充：

- `FAILED` 不允许继续正常查询。
- `CLOSED` 实例不能重新打开；如需再次使用，应重新调用 `open()`。
- `OPENING` 时取消操作必须清理已经分配的资源。
- 关闭时必须释放引擎连接、缓存、文件句柄及相关任务。
- 资源清理失败应有明确错误处理策略，不能静默假装全部成功。

## 四、SQL 查询接口

### 4.1 查询参数与结果

```
export interface QueryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface QueryColumn {
  name: string;
  type: string;
  nullable?: boolean;
}

export interface QueryResult<T> {
  columns: QueryColumn[];
  rows: T[];
  rowCount: number;
  executionTimeMs: number;
}
```

示例：

```
const result = await db.sql<{
  id: string;
  title: string;
}>(
  "SELECT id, title FROM documents WHERE category = ? LIMIT ?",
  ["biology", 20],
  { timeoutMs: 5_000 },
);
```

### 4.2 SQL 规范

| 项目   | V1 规则                            |
| ---- | -------------------------------- |
| 查询类型 | 只读查询                             |
| 参数   | 必须使用引擎支持的参数绑定                    |
| 多语句  | 默认拒绝，除非未来明确支持                    |
| 写操作  | `INSERT`、`UPDATE`、`DELETE` 等默认拒绝 |
| 系统命令 | 拒绝不属于公开查询能力的命令                   |
| 超时   | 尽可能支持；必须说明具体引擎的取消限制              |
| 结果   | 统一列元数据与结果格式                      |
| 类型转换 | 明确处理日期、时间、二进制、大整数等类型             |
| 资源限制 | 对结果行数、并发数和内存建立可配置限制              |

仅靠判断 SQL 字符串是否以 `SELECT` 开头，不能构成可靠的只读安全控制。必须在引擎适配层使用受限连接、只读模式或经过解析验证的查询策略。

## 五、向量搜索 API

### 5.1 类型定义

```
export type VectorMetric = "cosine" | "l2" | "ip";

export interface VectorSearchRequest {
  collection: string;
  vector: ArrayLike<number>;
  topK: number;
  filter?: FilterExpression;
  metric?: VectorMetric;
  mode?: "exact" | "approximate" | "auto";
  signal?: AbortSignal;
}

export interface VectorHit {
  id: string;
  row: number;
  distance: number;
  metadata?: Record<string, unknown>;
}

export interface VectorSearchResult {
  hits: VectorHit[];
  exact: boolean;
  elapsedMs: number;
}

export interface VectorSearchAPI {
  search(
    request: VectorSearchRequest,
  ): Promise<VectorSearchResult>;
}
```

### 5.2 距离语义

| 指标     | 计算定义                                        | 排序方向 |
| ------ | ------------------------------------------- | ---- |
| Cosine | \\(1-\frac{a\cdot b}{\\\|a\\\|\\\|b\\\|}\\) | 升序   |
| L2     | \\(\sqrt{\sum_i(a_i-b_i)^2}\\)              | 升序   |
| IP     | \\(-\sum_i a_i b_i\\)                       | 升序   |

约束：

- `topK` 必须为正安全整数。
- 查询向量维度必须匹配集合维度。
- 不允许 NaN、Infinity 或不合法的向量元素。
- Cosine 不接受零向量。
- 返回结果使用稳定的距离升序、行号升序规则。
- `exact: true` 表示对指定搜索范围保证全局精确 Top-K，而不是仅仅对 ANN 候选重新计算了精确距离。

## 六、结构化过滤与混合检索

### 6.1 过滤表达式

禁止将任意用户输入直接拼接到 SQL 中。使用结构化表达式描述过滤条件。

```
export type ScalarValue =
  | string
  | number
  | boolean
  | null;

export type FilterExpression =
  | {
      op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte";
      field: string;
      value: ScalarValue;
    }
  | {
      op: "in";
      field: string;
      values: ScalarValue[];
    }
  | {
      op: "and" | "or";
      conditions: FilterExpression[];
    }
  | {
      op: "not";
      condition: FilterExpression;
    };
```

V1 需要在执行前校验字段是否存在、操作符是否适用于字段类型，以及数组、递归深度和表达式大小是否超限。

### 6.2 混合检索 API

```
export interface HybridSearchRequest {
  collection: string;
  vector: ArrayLike<number>;
  topK: number;
  filter?: FilterExpression;

  strategy?: "exact-filter-first" | "vector-first";

  signal?: AbortSignal;
}

export interface HybridSearchAPI {
  search(
    request: HybridSearchRequest,
  ): Promise<VectorSearchResult>;
}
```

两种策略的契约必须明确：

- `exact-filter-first`：先取得符合条件的完整候选集合，再进行精确排序，保证过滤集合内的全局 Top-K。
- `vector-first`：先取得有限向量候选，再进行过滤。可能不足 K 条，且不能保证过滤集合内的全局 Top-K。

如果未来加入全文检索与重排序，应新增明确的混合排序模型，而不是把距离、全文分数和业务权重直接混加。不同分数需要归一化或使用明确的融合算法。

## 七、资源读取接口

```
export interface ResourceStat {
  size: number;
  etag?: string;
  lastModified?: string;
}

export interface ResourceReader {
  stat(path: string): Promise<ResourceStat>;

  readRange(
    path: string,
    offset: number,
    length: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;

  close(): Promise<void>;
}
```

### 资源读取规则

1. `offset` 与 `length` 必须是非负安全整数。
2. `offset + length` 必须安全，不允许整数溢出。
3. 非空范围读取成功时必须返回精确的字节数。
4. `length === 0` 返回空数组，不应发起不必要的网络请求。
5. 浏览器端必须验证 HTTP Range 行为；服务器忽略 Range 时默认返回 `RANGE_UNSUPPORTED`，不能悄悄下载整个大文件。
6. 文件缺失、范围越界、读取截断、网络失败、取消和关闭后读取分别映射到稳定错误码。
7. Node.js 必须同时验证规范化路径和真实文件路径边界，防止符号链接越界。
8. 远程读取需要处理 ETag 或版本化 URL，避免新旧数据包资源混用。
9. 哈希校验应区分“已验证”“未验证”和“校验失败”，不能把未验证标记为通过。

## 八、能力查询接口

```
const capabilities = db.capabilities();

if (capabilities.vector.available) {
  // 可以调用向量搜索
}

if (!capabilities.fullText.available) {
  // 使用明确的替代方案或提示功能不可用
}
```

能力查询用于解决不同运行环境的能力差异：

- 浏览器可能无法使用原生 Node 模块。
- 某个向量索引可能只在指定平台或构建目标下可用。
- SQL 引擎加载成功，不代表所有 SQL 语法都受支持。
- 数据包存在向量文件，不代表 ANN 索引可直接加载。
- 不能静默回退到更慢或语义不同的模式；任何降级必须可观测。

## 九、V1 API 验收用例

| 编号      | 场景             | 预期行为                              |
| ------- | -------------- | --------------------------------- |
| API-001 | 打开合法数据包        | 返回 READY 实例                       |
| API-002 | Manifest 版本不支持 | 抛出 `UNSUPPORTED_FORMAT_VERSION`   |
| API-003 | 打开时取消          | 清理资源并返回 `CANCELLED`               |
| API-004 | 参数化 SQL 查询     | 正确绑定参数并返回统一结果                     |
| API-005 | SQL 尝试写入       | 明确拒绝                              |
| API-006 | 查询向量维度错误       | 返回 `INVALID_VECTOR_DIMENSION`     |
| API-007 | 空向量集合搜索        | 返回空结果                             |
| API-008 | 精确搜索同距离结果      | 按行号稳定排序                           |
| API-009 | ANN 搜索         | 明确返回 `exact: false`               |
| API-010 | 关闭后继续查询        | 返回 `RESOURCE_CLOSED`              |
| API-011 | CDN 忽略 Range   | 返回 `RANGE_UNSUPPORTED`            |
| API-012 | 文件被截断          | 返回 `RESOURCE_TRUNCATED` 或明确的完整性错误 |
| API-013 | SQL 过滤字段不存在    | 返回 `INVALID_QUERY`                |
| API-014 | 引擎未安装或不可加载     | 返回 `ENGINE_UNAVAILABLE`           |
| API-015 | 查询中止           | 不将中止任务作为成功结果返回                    |

## 十、下一阶段：落实成工程规范

这份文档定义的是目标接口契约草案，尚未经过所有适配器和跨平台测试。进入编码前还需要固定三个细节：

1. `QueryResult` 对大结果集的处理方式：是否只提供分页或异步迭代器，避免一次性返回大量行。
2. `close()` 与并发查询之间的行为：立即取消、等待完成，还是支持可配置策略。
3. 远程资源版本一致性：如何使用 Manifest、资源哈希、ETag 和不可变版本目录保证一次查询只读取同一版本的数据。

下一步应当先解决这些接口边界，再将公开 API 转为真实 TypeScript 声明文件和契约测试。这样后续接入 DuckDB-Wasm、Node 文件读取和向量索引时，就不会因为基础接口不稳定而反复重构。

