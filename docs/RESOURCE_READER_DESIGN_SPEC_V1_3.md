# WeiSQL AI 技术文档 V1.3

资源读取层设计规范

Resource Reader · Cache · Integrity · Lifecycle

设计规范

文档版本

V1.3

适用范围

Node.js / Browser

部署模式

本地文件 / 静态 CDN

实现状态

待测试验证

### 与当前仓库的差异

本文是**设计规范**。资源读取层已实现并有自动化测试，**上面「实现状态：待测试验证」已过时**。实际落地情况：

| 本文的设计 | 当前仓库的实际状态 |
| --- | --- |
| `packages/resource-reader/` 独立包 | 内置于 `@weisql/sdk`（`http-resource-reader.ts`、`node-file-resource-reader.ts`、`cached-resource-reader.ts`） |
| 缓存作为独立组件 | 实现为 `CachedResourceReader` **装饰器**，`open({ cache })` 自动套在 Reader 外层（见 ADR-019） |
| 完整性校验内嵌于读取路径 | 独立为 `verifyChecksums`，在 **任何 Adapter 接触资源之前**执行，分 `none` / `manifest` / `all` 三级 |
| 生命周期与取消语义 | 已实现：幂等 `close()`、取消所有权归调用方、仅当全部等待者取消才中断底层读取 |
| 本地文件 / 静态 CDN 两种部署模式 | 都已实现，但真实 CDN（Netlify）尚未做真实验收 |

以 [`RESOURCE_READER_CONTRACT.md`](RESOURCE_READER_CONTRACT.md) 与 [`RESOURCE_INTEGRITY_SPEC.md`](RESOURCE_INTEGRITY_SPEC.md) 为准，那两份已由实现与测试验证。

## 一、资源读取层的设计目标

WeiSQL AI 的资源读取层负责从本地目录或 HTTP 静态资源中读取数据，为 SQL 引擎、向量搜索引擎和混合检索提供统一的字节访问接口。

它不负责解析 SQL、不负责向量排序，也不负责理解 Parquet 的内部结构。

核心目标如下：

1. 按需读取： 支持随机字节区间访问，不要求一次加载整个数据文件。
2. 资源一致性： 防止一次查询过程中混用不同版本的数据文件。
3. 内存可控： 缓存大小、并发读取数和单次读取大小均可配置。
4. 错误统一： 不同运行环境使用一致的错误码。
5. 生命周期明确： 取消、关闭、并发请求和缓存释放具有明确语义。
6. 环境隔离： 浏览器版本不依赖 Node.js 文件系统 API。

## 二、模块结构与职责

```
packages/resource-reader/
├── src/
│   ├── index.ts
│   ├── validate-range.ts
│   ├── node-file-reader.ts
│   ├── http-range-reader.ts
│   ├── cached-reader.ts
│   ├── concurrency-limiter.ts
│   └── resource-version.ts
└── tests/
    ├── validate-range.test.ts
    ├── node-file-reader.test.ts
    ├── http-range-reader.test.ts
    ├── cached-reader.test.ts
    └── resource-version.test.ts
```

| 模块                   | 主要职责               | 不负责的工作   |
| -------------------- | ------------------ | -------- |
| `NodeFileReader`     | 本地文件元数据与区间读取       | SQL 解析   |
| `HttpRangeReader`    | HTTP Range 请求与响应验证 | 数据库查询    |
| `CachedReader`       | 分块缓存、淘汰和重复请求合并     | 修改原始数据   |
| `ConcurrencyLimiter` | 限制同时执行的读取任务        | 引擎内部线程调度 |
| `ResourceVersion`    | 固定数据集版本和校验器        | 验证发布者身份  |
| `validate-range`     | 检查偏移量和长度           | 文件系统权限检查 |

## 三、统一资源读取协议

公共接口维持不变：

```
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

### 3.1 `readRange` 的严格语义

对于：

```
await reader.readRange(
  "vectors/embeddings.f32",
  4096,
  1024,
);
```

调用方期望得到文件偏移量 4096 开始的连续 1024 字节。

必须满足：

- 返回字节数严格等于 1024。
- 不允许返回静默截断的数据。
- 不允许把偏移量解释成元素索引。
- 不允许在底层读取失败时返回伪造的空数据。
- `length === 0` 时返回空 `Uint8Array`。
- 非空读取超出文件边界时返回明确错误。
- 已关闭的读取器拒绝新的读取任务。

对于浏览器端，服务器必须支持所需的 Range 行为；不支持时默认报错，不应悄悄退化成整文件下载。

### 3.2 范围和内存限制

推荐增加以下配置：

```
export interface RuntimeResourceOptions {
  maxCacheBytes: number;
  maxConcurrentReads: number;
  maxRangeBytes: number;
  verifyResourceHashes: boolean;
}
```

建议的初始默认值：

| 参数                     | 建议默认值  | 说明              |
| ---------------------- | ------ | --------------- |
| `maxCacheBytes`        | 64 MiB | 分块缓存总预算         |
| `maxConcurrentReads`   | 8      | 同时执行的读取任务数      |
| `maxRangeBytes`        | 8 MiB  | 单次 Range 最大字节数  |
| `verifyResourceHashes` | `true` | 对声明哈希的资源执行完整性验证 |

这些是初始工程配置建议，不是已测得的最优参数。特别是 `maxRangeBytes`，应当结合浏览器内存、网络往返延迟和实际 Parquet 读取模式进行基准测试。

对于需要验证整文件 SHA-256 的场景，应当分块累计哈希，而不是把整个文件拼接到内存后再计算。

## 四、分块缓存设计

### 4.1 为什么不能只缓存完整文件

假设一个数据集包含 100 万条 768 维 Float32 向量：

\\[ 1{,}000{,}000\times768\times4 =3{,}072{,}000{,}000\text{ bytes} \\]

仅原始向量数据就约为 2.86 GiB，尚未计入索引、SQL 执行内存和其他缓存。

因此，浏览器端不能采用“第一次读取时将全部资源放进内存”的默认策略。

### 4.2 分块策略

建议将资源分成固定大小的缓存块，例如 1 MiB：

示例：一个 4 MiB 文件

块 0

1 MiB

块 1

1 MiB

块 2

1 MiB

块 3

1 MiB

读取偏移量 1.5 MiB 附近的数据时，只需获取对应块；其他块不必提前下载。

缓存键必须包含数据集版本：

```
{datasetVersion}:{resourcePath}:{blockIndex}
```

例如：

```
release-2026-10-30:vectors/embeddings.f32:3
```

这样可防止同一路径在不同版本下返回旧缓存。

### 4.3 LRU 淘汰策略

采用 LRU（Least Recently Used，最近最少使用）作为首版缓存淘汰策略。

规则：

1. 读取缓存块时更新其最近访问顺序。
2. 缓存命中时直接返回所需字节区间。
3. 缓存未命中时执行底层读取。
4. 新数据进入缓存前检查总字节预算。
5. 超出预算时先淘汰最久未访问的缓存块。
6. 单块大于缓存预算时可以直接返回数据，但不缓存该块。
7. 缓存释放后，不能影响调用方已经获得的字节数据。

必须避免可变缓存数据泄漏。 如果底层缓存保存的是一个 `Uint8Array`，直接把它交给调用方可能导致调用方修改缓存内容。安全的默认方案是返回拷贝，或者使用严格的只读封装；前者更容易实现和测试，但会增加内存复制成本。

### 4.4 重复请求合并

多个并发查询可能同时读取同一缓存块。

缓存层应当维护正在执行的请求表：

```
blockKey -> Promise<Uint8Array>
```

如果请求已存在，后续读取可以复用同一个底层请求，避免重复下载。

需要注意取消语义：不能因为其中一个调用方取消，就直接取消其他调用方仍在等待的共享请求。应采用引用计数或独立的等待者取消机制；若暂不实现，首版可以只合并请求、让底层读取持续到完成或超时。

## 五、数据集版本一致性

这是静态数据包非常重要的可靠性问题。

假设：

- `manifest.json` 描述版本 A。
- 浏览器开始读取版本 A 的向量文件。
- CDN 发布新版本 B，并覆盖了同一个文件 URL。
- 后续 Range 请求可能返回版本 B 的字节。

最终会出现 Manifest 与实际数据不一致的问题。

### 5.1 推荐方案：不可变版本目录

```
public/
└── datasets/
    ├── release-a1b2/
    │   ├── manifest.json
    │   ├── data/
    │   │   └── documents.parquet
    │   └── vectors/
    │       └── embeddings.f32
    └── release-c3d4/
        ├── manifest.json
        ├── data/
        └── vectors/
```

发布新版本时，创建新目录而不是原地覆盖旧文件。

这样，运行时可以固定使用某个版本，旧查询不会在中途切换到新版本。

### 5.2 HTTP 校验器

HTTP 读取器可利用 `ETag` 和 `Last-Modified` 等元数据识别资源变化。

在适用时使用 `If-Range` 或条件请求，但必须理解服务器和 CDN 的实际行为。不能假定所有静态托管服务都具有相同的缓存和校验器策略。

如果请求发现资源版本变化：

- 终止当前不一致的读取操作。
- 清除受影响的缓存。
- 返回明确错误。
- 由上层决定是否重新打开整个数据集。

不能只重试某一个 Range，然后把新旧字节拼接起来。

### 5.3 SHA-256 校验

资源声明：

```
{
  "path": "vectors/embeddings.f32",
  "bytes": 3072000,
  "sha256": "实际文件的SHA256十六进制值"
}
```

必须区分三个概念：

| 检查         | 能证明什么               |
| ---------- | ------------------- |
| 文件大小检查     | 文件长度符合声明            |
| SHA-256 检查 | 文件字节与指定摘要匹配         |
| 数字签名验证     | 在可信公钥与签名规则下验证来源和完整性 |

哈希字段本身不等于数字签名。对于大文件，可以使用增量哈希降低峰值内存；但若要验证整文件哈希，仍需要确保实际参与计算的字节覆盖整个文件，而不是只验证几个随机 Range。

## 六、并发与关闭语义

### 6.1 并发控制

`maxConcurrentReads = 8` 表示同一读取器同时执行的底层读取任务最多为 8 个。

等待队列也应有限制，避免大量任务无限堆积。建议增加：

```
export interface ConcurrencyOptions {
  maxConcurrentReads: number;
  maxQueuedReads: number;
}
```

队列容量耗尽时，使用统一的资源限制错误拒绝新任务，而不是无限等待。

### 6.2 关闭状态机

`OPEN`

`CLOSING`

拒绝新任务、取消或等待进行中的任务

`CLOSED`

释放缓存和底层资源

推荐规则：

- 第一次调用 `close()` 后立即进入 `CLOSING`。
- 进入 `CLOSING` 后拒绝新的读取。
- 已排队但尚未开始的任务按取消策略终止。
- 进行中的任务按约定取消或等待结束。
- 清理工作只执行一次。
- 多次调用 `close()` 返回同一个关闭结果。
- 关闭完成后，所有新的读取操作返回 `RESOURCE_CLOSED`。

运行时应使用内部 `AbortController` 管理底层请求，并将调用方的 `AbortSignal` 与读取器生命周期结合起来。共享请求则需额外处理多个调用方的取消关系。

## 七、错误处理规范

建议维持统一错误码，并补充资源层错误的适用场景。

| 错误码                      | 触发场景          | 自动重试建议    |
| ------------------------ | ------------- | --------- |
| `INVALID_PATH`           | 非法资源路径        | 不重试       |
| `RESOURCE_RANGE_INVALID` | 请求超出有效范围      | 不重试       |
| `RESOURCE_TRUNCATED`     | 响应字节数或区间不正确   | 校验版本后谨慎重试 |
| `RANGE_UNSUPPORTED`      | 服务端忽略 Range   | 不自动重试     |
| `NETWORK_ERROR`          | 网络连接或 HTTP 错误 | 部分错误可退避重试 |
| `CANCELLED`              | 调用方或读取器取消     | 不重试       |
| `RESOURCE_CLOSED`        | 已关闭的读取器收到新任务  | 不重试       |
| `RESOURCE_LIMIT`         | 并发、队列或内存预算超限  | 降低负载后再试   |
| `HASH_MISMATCH`          | 资源摘要校验失败      | 不应继续使用该资源 |

重试必须有上限、退避间隔和总超时。对于校验失败，不应将重试作为掩盖数据版本不一致的手段。

## 八、自动化测试标准

测试分为三个层级。

### A. 单元测试

- Range 边界及整数溢出。
- LRU 淘汰顺序。
- 缓存字节预算。
- 重复请求合并。
- 关闭状态与幂等性。
- 不同数据集版本之间的缓存隔离。

### B. 集成测试

- Node.js 随机读取与原文件切片一致。
- HTTP 206 返回正确字节。
- HTTP 200 不被误认为成功的 Range 响应。
- HTTP 416 转换为稳定错误。
- 取消请求后能够清理等待状态。
- 文件或服务器资源发生版本变化时不混合数据。

### C. 浏览器与部署测试

- Netlify 或目标静态服务器支持预期的 Range 行为。
- CORS 配置满足跨域读取要求。
- 缓存头不会导致不同版本的资源混用。
- 大文件随机读取不触发整文件下载。
- 长时间读取过程中内存占用维持在配置预算附近。
- 关闭 Runtime 后，未完成请求最终得到清理。

在这些测试实际执行之前，不应宣称缓存命中率、百万级向量读取速度或峰值内存已经达标。

## 九、文档体系更新

建议把现有文档整理为统一目录，避免 API 约定与工程实现互相脱节。

| 文档                     | 版本   | 主要内容                      |
| ---------------------- | ---- | ------------------------- |
| `requirements.md`      | V0.9 | 产品范围、功能需求、验收目标            |
| `api-contract.md`      | V1.0 | 公共 SDK API 和错误码           |
| `runtime-semantics.md` | V1.1 | 生命周期、取消、分页和一致性            |
| `engineering-spec.md`  | V1.2 | Monorepo、构建与工程约定          |
| `resource-reader.md`   | V1.3 | Range、缓存、版本一致性和并发         |
| `manifest-v1.md`       | 待整理  | Manifest 结构、语义与完整性验证      |
| `vector-search.md`     | 待编写  | 精确搜索、Top-K、距离度量和 ID 映射    |
| `benchmark-plan.md`    | 待编写  | Recall\@K、P50/P95、内存及构建时间 |
| `release-checklist.md` | 待编写  | 包发布、兼容性、完整性与部署检查          |

以上是本轮补充的文档正文和工程约定，现已写入项目文档；其中新增或尚未落地的工程约定仍需通过代码测试与部署验证。

接下来最值得继续完善的是《向量搜索核心算法与一致性规范》：把 Float32 解码、余弦/L2/内积距离、Top-K 最大堆、稳定排序、分块扫描、ID 映射随机读取和 Recall\@K 测试整合成可实施的开发文档。

