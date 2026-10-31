---
title: 打开数据库与生命周期
description: 用 open() 创建只读 Runtime，说明 Manifest 来源、Reader 归属、状态机与幂等 close() 的边界。
sidebar_position: 20
hero:
  kicker: "SDK · 生命周期"
  title: "打开、查询、关闭"
  lead: "open() 是唯一入口；Reader 与 Adapter 在这里注入，生命周期由 Runtime 持有。"
  chips: ["open()", "capabilities()", "close()"]
hide_title: true
examples: [node, browser]
---


本页说明如何用 `open()` 打开一个只读数据包，以及返回的 `WeiSQLDatabase` 在打开、就绪、关闭各阶段的行为。读完后你应该能安全地选择 Manifest 来源、注入 Reader 与 Adapter，并在应用退出时正确释放资源。

## 最小示例

Node.js 端从本地目录打开一个数据包：

```ts
import { readFile } from "node:fs/promises";
import { open, NodeFileResourceReader } from "@weisql/sdk";

// manifestUrl 走全局 fetch；本地目录不是 HTTP 服务，所以先读文件再传 manifest 对象。
const manifest = JSON.parse(await readFile("./demo/manifest.json", "utf8"));

const db = await open({
  manifest,
  resourceReader: new NodeFileResourceReader({ rootDirectory: "./demo" }),
  verifyChecksums: "manifest",
});

console.log(db.state);        // "READY"
console.log(db.manifest.datasetId);

const hits = await db.vector.search("document_embeddings", [1, 0], { topK: 3 });
console.log(hits.map(hit => hit.id));

await db.close();
```

浏览器端把同样的逻辑换成 HTTP：

```ts
import { open, HttpResourceReader } from "@weisql/sdk";

const db = await open({
  manifestUrl: "/datasets/demo/manifest.json",
  resourceReader: new HttpResourceReader({ baseUrl: "/datasets/demo/" }),
  cache: { maxCacheBytes: 32 * 1024 * 1024 },
});
```

已经拿到 Manifest 对象时，可以不发请求：

```ts
const db = await open({ manifest, resourceReader: reader });
```

## OpenOptions

`manifestUrl` 与 `manifest` 必须且只能提供一个，否则抛 `INVALID_ARGUMENT`。

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `manifestUrl` | `string` | 无 | Manifest 的 URL；用注入的 `fetch` 拉取 |
| `manifest` | `unknown` | 无 | 已解析的 JSON；仍会经过 `validateManifest()` |
| `mode` | `"readonly"` | 无 | V1 只接受 `readonly`；传其他值抛 `INVALID_ARGUMENT` |
| `verifyChecksums` | `"none" \| "manifest" \| "all"` | `"none"` | 打开时的 L3 策略，详见下文 |
| `fetch` | `typeof fetch` | 全局 `fetch` | 拉取 Manifest 用；保留全局接收者以避免浏览器 `Illegal invocation` |
| `resourceReader` | `ResourceReader` | 无 | 资源读取器；向量、全文、`verifyChecksums` 都需要它 |
| `sqlAdapter` | `SqlAdapter` | 无 | 注入后 `sql()` / `sqlStream()` 与向量过滤可用 |
| `vectorAdapter` | `VectorAdapter` | 无 | 注入后向量搜索走 Adapter；不注入走内置精确管线 |
| `cache` | `CacheOptions` | 无 | 提供时自动把 `resourceReader` 包进 `CachedResourceReader` |
| `signal` | `AbortSignal` | 无 | 取消打开过程 |

`cache` 的字段是 `maxCacheBytes`、`maxEntryBytes`、`maxConcurrentReads`、`version`，语义见下一节以及资源读取器页面。

## 打开顺序

`open()` 的步骤是固定的，不满足前置条件时不会碰资源：

1. 检查 `mode` 与 Manifest 来源是否合法；
2. 若已取消，抛 `QUERY_CANCELLED`；
3. 拉取并解析 Manifest，再执行 `validateManifest()`（L1/L2）；
4. 若配置了 `cache`，包装 Reader；
5. 若 `verifyChecksums` 不是 `none`，先做 L3 完整性校验；
6. 创建 Database，按顺序 `sqlAdapter.open()`、`vectorAdapter.open()`；
7. 置为 `READY`。

因此 `verifyChecksums: "all"` 一定发生在任何 Adapter 接触资源之前。若第 5 步之前失败，`open()` 会关闭传入的 Reader；进入 Database 创建阶段后，由 Database 自己清理。

## 只读与 Adapter 约束

- `mode` 只有 `"readonly"`；V1 不提供写接口，也不从底层引擎推断写能力。
- 注入 `sqlAdapter` 或 `vectorAdapter` 时必须同时提供 `resourceReader`，否则 `INVALID_ARGUMENT`。Adapter 的所有字节都来自 Reader，没有 Reader 就没有独立的数据通道。
- 未注入 `resourceReader` 时：向量搜索与全文搜索都抛 `INDEX_NOT_FOUND`；SQL 也无法启用，因为注入任何 Adapter 都要求同时提供 Reader。
- 未注入 `sqlAdapter` 时：`sql()` 与 `sqlStream()` 抛 `SQL_UNSUPPORTED`；带 `filter` 的向量搜索同样抛 `SQL_UNSUPPORTED`，不会静默忽略过滤条件。
- 数据包与 Manifest 均视为不可信输入；路径、摘要和声明字节数在读取前校验。

## state 状态机

`state` 是只读属性，取值如下：

| 值 | 含义 |
| --- | --- |
| `OPENING` | 对象已构造，Adapter 尚未就绪 |
| `READY` | 可以使用；所有查询都要求处于该状态 |
| `CLOSING` | `close()` 已开始，资源释放中 |
| `CLOSED` | 已关闭；后续操作返回 `DATABASE_CLOSED` |
| `FAILED` | 打开失败，资源已尽力释放 |

实现上 `OPENING` 是构造到就绪之间的内部阶段，`open()` 成功返回时对象已是 `READY`；`FAILED` 只出现在打开失败的实例上，而失败时 `open()` 会抛错，调用方拿不到对象。

## close() 幂等

`close()` 可以重复调用，第二次直接返回。并发调用共享同一个关闭 Promise，不会重复释放。

```ts
await db.close();
await db.close();       // 直接返回
await db.vector.search("document_embeddings", [1, 0]); // DATABASE_CLOSED
```

关闭会关闭全文读取器、ID 索引、`vectorAdapter`、`sqlAdapter` 和 `resourceReader`。任何一个资源释放失败都会抛 `INTERNAL_ERROR`，但 `state` 仍会落到 `CLOSED`。

Runtime 拥有注入 Reader 的生命周期：`open()` 成功后由 `close()` 关闭它。不要在外层重复关闭同一个实例并期待不同结果，Reader 的 `close()` 本身也是幂等的。

## capabilities()

`capabilities()` 返回冻结对象，字段全为 `boolean`：

| 字段 | 何时为 true |
| --- | --- |
| `sql` | 注入了 `sqlAdapter` |
| `vectorExactSearch` | 未注入向量 Adapter 且有 Reader；或 Adapter 声明 `exactSearch: true` |
| `vectorAnnSearch` | 注入了向量 Adapter 且它不声明精确 |
| `hybridSearch` | 有 Reader、有 `sqlAdapter`，且向量 Adapter 未注入或声明精确 |
| `textSearch` | 有 Reader 且 Manifest 声明了至少一个 `textIndexes` |
| `fusionSearch` | 有 Reader，且存在向量集合或文本索引 |
| `ragSearch` | 有 Reader 且至少一个文本索引声明了 `documents` |
| `resourceRange` | 注入了 `resourceReader` |

这些布尔值描述“当前实例的接线”，不是对每次调用的承诺。例如 `hybridSearch` 的判定包含 `sqlAdapter`，而 `hybrid.search()` 本身不执行 SQL；`textSearch` 为 true 也不代表某个具体索引一定存在。

## 常见错误

| 错误码 | 触发场景 |
| --- | --- |
| `INVALID_ARGUMENT` | 同时或都未提供 `manifestUrl` / `manifest`；`mode` 非 `readonly`；`verifyChecksums` 取值非法；注入了 Adapter 却没有 Reader |
| `MANIFEST_INVALID` | Manifest 结构或跨字段校验失败；`details.issues` 给出字段路径 |
| `FORMAT_VERSION_UNSUPPORTED` | `formatVersion` 不是 `1.0.0`；`details.supported` 给出支持值 |
| `RESOURCE_NOT_FOUND` | Manifest 请求 404 或网络失败；`details.status` 或 `details.cause` |
| `RESOURCE_INTEGRITY_FAILED` | 开启 L3 后尺寸或摘要不符 |
| `QUERY_CANCELLED` | 打开过程中 `signal` 被触发 |
| `DATABASE_CLOSED` | 关闭后执行查询；`capabilities()` 与 `state` 仍可读取 |
| `INTERNAL_ERROR` | 没有可用 `fetch`；关闭阶段资源释放失败 |

`open()` 失败不会返回半可用对象；捕获 `WeiSQLError` 后按 `code` 分支即可，不要匹配错误消息文本。

## 行为边界

- 只读：没有写入、DDL 或事务接口；SQL 的只读边界由 Adapter 负责。
- 打开时不校验 Parquet 内容；列一致性由 SQL Adapter 的 L4 校验负责。
- `verifyChecksums: "none"` 不访问任何资源，因此损坏的数据包要到第一次查询才暴露。
- 打开过程中的网络错误统一映射为 `RESOURCE_NOT_FOUND`，不区分 404 与连接失败。
- 真实 CDN 的 CORS 与缓存行为未验证，见[兼容性](/docs/reference/compatibility)。

## 延伸阅读

- [SDK API 契约](https://github.com/fengjutian/WeiSQL/blob/main/docs/SDK_API_CONTRACT_V1.md)
- [资源完整性校验规范](https://github.com/fengjutian/WeiSQL/blob/main/docs/RESOURCE_INTEGRITY_SPEC.md)
- [浏览器与 Node.js 兼容性](https://github.com/fengjutian/WeiSQL/blob/main/docs/RUNTIME_COMPATIBILITY.md)
