# WeiSQL V0.6 Runtime 基础设计

- 状态：实施中
- 更新日期：2026-10-30
- 范围：统一资源读取、HTTP Range、Node 文件读取、有界缓存和精确向量搜索基线

## 1. 工程目标

浏览器和 Node.js 使用同一个公开数据库 API、Manifest 契约和 `ResourceReader` 抽象。SQL 与向量 Adapter 只能依赖资源接口，不直接调用 `fetch` 或 Node 文件系统。

当前继续保留单一 `@weisql/sdk` 工程，以便在接口稳定前避免过早拆包。未来拆分 `core`、`runtime-browser`、`runtime-node` 和 `vector` 时必须保留导出路径或提供明确迁移版本。

## 2. 已冻结的 Reader 语义

读取范围使用 `{ start, end }` 左闭右开区间 `[start, end)`，而不是另一套 `offset + length` API。长度为 `end - start`；空范围返回零长度数组且不进行 I/O。两端必须是非负安全整数。

Reader 提供：

- `read()`：只适用于受大小上限约束的完整读取；
- `readRange()`：返回精确范围，不允许静默短读；
- `stat()`：返回可用的大小、验证器和 Range 能力；
- `close()`：幂等，关闭后拒绝新操作。

统一错误码沿用 `PUBLIC_TYPES_AND_ERRORS_V1.md`：路径错误为 `PATH_INVALID`，缺失资源为 `RESOURCE_NOT_FOUND`，取消为 `QUERY_CANCELLED`，关闭为 `DATABASE_CLOSED`，范围响应协议错误为 `INVALID_RANGE_RESPONSE`，截断或大小不符为 `RESOURCE_INTEGRITY_FAILED`。不得为不同 Reader 引入同义公开错误码。

## 3. 浏览器 HTTP Reader

当前实现已覆盖：

- 受控 HTTP(S) 包根和重定向 containment；
- 严格验证 `206`、`Content-Range` 和响应字节数；
- 拒绝将忽略 Range 的 `200` 响应作为范围结果；
- `404`、网络失败、取消和关闭的稳定错误映射；
- HEAD 元数据、`Content-Length`、ETag、Last-Modified 与 `Accept-Ranges`。

真实 CDN 仍需验证 CORS 暴露头、缓存、Range、重定向和取消行为。ETag 或不可变 URL 用于缓存身份，不能代替 SHA-256 内容校验。

## 4. Node 文件 Reader

`NodeFileResourceReader` 已提供：

- V1 逻辑路径校验；
- 包根和目标的 `realpath` containment，拒绝符号链接逃逸；
- 文件类型检查、精确范围读取和短读检测；
- 完整读取字节上限；
- 预取消检查和幂等关闭；
- Windows 与 POSIX 通用的 `path.relative` 根范围判断。

当前 `close()` 立即拒绝新操作，但不会强制打断已经进入操作系统的单次文件读取。`realpath` 与 `open` 之间仍存在 TOCTOU 窗口；高安全部署需要进一步评估基于句柄的身份复核、平台安全打开能力和并发文件句柄上限。

## 5. 有界缓存设计

缓存作为 Reader 装饰器，而不是混入 HTTP 或文件实现。推荐三层：

| 层级 | 内容 | 所有者 |
| --- | --- | --- |
| L1 | 已解析并校验的 Manifest | Runtime |
| L2 | 向量块、偏移与 ID 记录 Range | CachedResourceReader |
| L3 | SQL/向量引擎内部页与索引 | Adapter |

L2 缓存键至少包含：

```text
发布版本身份 + 资源路径 + start + end + SHA-256 或强 ETag
```

实现要求：

- 按实际字节数计费并执行 LRU 或等价的有界淘汰；
- 单块与总缓存预算均可配置；
- 对相同块合并并发请求；
- 所有等待者取消后才取消共享底层请求；
- 不缓存失败、短读或未通过完整性检查的响应；
- 发布版本变化后隔离旧缓存；
- 暴露命中率、淘汰量、Range 数量和读取字节数用于基准报告。

建议配置形状如下，默认数值必须由真实设备测试后确定：

```ts
interface RuntimeResourceOptions {
  maxCacheBytes: number;
  maxConcurrentReads: number;
  maxRangeBytes: number;
  verifyResourceHashes: boolean;
}
```

缓存实现进入公开 API 前必须补齐取消所有权和版本身份测试。

## 6. 精确向量搜索基线

当前 SDK 已实现分块 Float32 解码、Cosine/L2/IP 距离、固定容量 Top-K 最大堆、稳定行号排序、Indexed ID Map 批量随机读取及取消。空集合直接返回空结果；搜索不会一次性载入全部向量。

精确搜索是 ANN 的排序和 Recall@K Ground Truth，不是百万级浏览器查询的性能承诺。性能记录必须同时包含 Range 请求数、平均请求大小、缓存命中率、P50/P95、峰值内存和总读取字节数。

## 7. V0.6 验收状态

| 项目 | 状态 |
| --- | --- |
| 统一 ResourceReader 与半开区间 | 已实现 |
| 严格 HTTP Range 单元测试 | 已实现 |
| Node 文件 Reader 与路径安全测试 | 已实现 |
| 精确搜索和 Top-K 对照测试 | 已实现 |
| Indexed ID Map 随机读取 | 已实现 |
| 有界 LRU 与请求合并 | 已实现（`CachedResourceReader`） |
| 流式 SHA-256 Integrity 层 | 待实现 |
| 真实 Netlify/CDN 验收 | 待实施 |
| DuckDB-Wasm 最小静态演示 | 待实施 |

