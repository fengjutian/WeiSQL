---
title: Runtime API
description: 速查 open() 的选项、校验顺序与错误码，WeiSQLDatabase 的完整接口、RuntimeState 五态，以及 capabilities() 八个布尔字段的触发条件。
sidebar_position: 71
hero:
  kicker: "API · Runtime"
  title: "open() 与它的对象"
  lead: "选项、状态机、能力声明与关闭语义。"
  chips: ["open()", "capabilities()", "close()"]
hide_title: true
---


本页是 Runtime 的签名速查：`open()` 的选项与校验顺序、`WeiSQLDatabase` 接口、状态机取值和 `capabilities()` 判定条件。生命周期讲解见 [打开数据库与生命周期](/docs/sdk/open-and-lifecycle)。

## 导入

```ts
import { open } from "@weisql/sdk";
import type { CacheOptions, OpenOptions, RuntimeState, WeiSQLCapabilities, WeiSQLDatabase } from "@weisql/sdk";
```

## open() 签名

```ts
function open(options: OpenOptions): Promise<WeiSQLDatabase>;
```

Node 本地目录没有 HTTP 端点，`manifestUrl` 只会交给 `fetch`，因此必须先读文件得到 Manifest 对象：

```ts
import { readFile } from "node:fs/promises";
import { open, NodeFileResourceReader } from "@weisql/sdk";

const manifest = JSON.parse(await readFile("./demo/manifest.json", "utf8"));
const db = await open({
  manifest,
  resourceReader: new NodeFileResourceReader({ rootDirectory: "./demo" }),
});

console.log(db.state); // "READY"
await db.close();
```

浏览器里把 Manifest 换成 URL，并复用同一个 Reader 做 Range 读取：

```ts
import { HttpResourceReader, open } from "@weisql/sdk";

const db = await open({
  manifestUrl: "/datasets/demo/manifest.json",
  resourceReader: new HttpResourceReader({ baseUrl: "/datasets/demo/" }),
  cache: { maxCacheBytes: 32 * 1024 * 1024 },
});
```

## OpenOptions

`manifestUrl` 与 `manifest` 必须二选一：同时提供或都未提供都抛 `INVALID_ARGUMENT`。

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `manifestUrl` | `string` | 无 | Manifest 的 URL，用 `fetch` 拉取后仍过 `validateManifest()` |
| `manifest` | `unknown` | 无 | 已解析的 Manifest；不发起 Manifest 请求 |
| `mode` | `"readonly"` | 无 | 唯一合法值；其他值抛 `INVALID_ARGUMENT` |
| `verifyChecksums` | `"none" \| "manifest" \| "all"` | `"none"` | 打开时的 L3 策略；非 `none` 时必须有 `resourceReader` |
| `fetch` | `typeof fetch` | 全局 `fetch` | 仅用于拉取 Manifest；缺失且无全局实现时 `INTERNAL_ERROR` |
| `resourceReader` | `ResourceReader` | 无 | 资源读取器；向量、全文、RAG、L3 都依赖它 |
| `sqlAdapter` | `SqlAdapter` | 无 | 注入后 `sql()` / `sqlStream()` 与向量过滤可用 |
| `vectorAdapter` | `VectorAdapter` | 无 | 注入后向量搜索走 Adapter，否则走内置精确管线 |
| `cache` | `CacheOptions` | 无 | 与 `resourceReader` 同时提供时自动包一层 `CachedResourceReader` |
| `signal` | `AbortSignal` | 无 | 取消打开；已取消时抛 `QUERY_CANCELLED` |

`cache` 字段：`maxCacheBytes` 默认 32 MiB、`maxEntryBytes` 默认 1 MiB、`maxConcurrentReads` 默认 8、`version` 默认 `manifest.datasetId`（显式传入则覆盖）。只给 `cache` 不给 Reader 不会报错，缓存也不生效；字段语义与 `stats()` 见 [Readers API](/docs/api/readers)。

## WeiSQLDatabase

```ts
interface WeiSQLDatabase {
  readonly manifest: Readonly<WeiSQLManifest>;
  readonly state: RuntimeState;
  sql<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string, params?: readonly SQLValue[], options?: QueryOptions,
  ): Promise<readonly T[]>;
  sqlStream<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string, params?: readonly SQLValue[], options?: QueryOptions,
  ): Promise<AsyncIterable<T>>;
  readonly vector: { search(vectorName: string, queryVector: Float32Array | readonly number[], options?: VectorSearchOptions): Promise<readonly VectorHit[]> };
  readonly text: { search(indexName: string, query: string, options?: TextSearchOptions): Promise<readonly TextHit[]> };
  readonly hybrid: { search(options: HybridSearchOptions): Promise<readonly HybridFusionHit[]> };
  readonly rag: { search(options: RagSearchOptions): Promise<RagResult> };
  capabilities(): Readonly<WeiSQLCapabilities>;
  close(): Promise<void>;
}
```

| 成员 | 默认值 / 返回 | 行为 |
| --- | --- | --- |
| `sql()` | `params` 默认 `[]`；`QueryOptions` 含 `signal`、`maxRows` | 无 Adapter 抛 `SQL_UNSUPPORTED` |
| `sqlStream()` | `AsyncIterable<T>` | Adapter 未实现 `stream` 时回退为物化后的 `query()`，正确但不惰性 |
| `vector.search()` | `topK` 默认 10 | 未注入向量 Adapter 时走内置精确扫描 |
| `text.search()` | `topK` 默认 10 | 只有 Manifest 声明了该索引才可查 |
| `hybrid.search()` | `topK` 默认 10，`k` 默认 60 | 至少给一个来源；每个来源默认取 `max(topK × 4, topK)` |
| `rag.search()` | `topK` 默认 5，`k` 默认 60，`maxCharacters` 默认 4000 | `text` 必填，索引必须声明 `documents` |
| `capabilities()` | 冻结的八布尔对象 | 不检查 `state`，关闭后仍可调用 |
| `close()` | `Promise<void>` | 幂等，见下文 |

`vector.search()` 校验顺序固定：`topK` 为正安全整数（`VECTOR_INVALID_VALUE`）→ 集合名存在（`INDEX_NOT_FOUND`）→ 维度等于 `dimension`（`VECTOR_DIMENSION_MISMATCH`）→ 分量有限、Cosine 查询非全零（`VECTOR_INVALID_VALUE`）→ 只给 `strategy` 不给 `filter` 抛 `INVALID_ARGUMENT` → 有 `filter` 但无 `sqlAdapter` 抛 `SQL_UNSUPPORTED`。

`hybrid.search()` 在两个来源都为空时返回 `[]`，不抛错；`rag.search()` 在文本索引缺少 `documents` 时抛 `INVALID_ARGUMENT`，不会退化成无上下文的拼接。

## RuntimeState

| 值 | 含义 | 调用方能否看到 |
| --- | --- | --- |
| `OPENING` | 对象已构造，Adapter 尚未就绪 | 否，仅内部阶段 |
| `READY` | 所有查询的唯一可用状态 | 是，`open()` 成功返回时 |
| `CLOSING` | `close()` 已开始，资源释放中 | 是，关闭竞态期间 |
| `CLOSED` | 已关闭；查询抛 `DATABASE_CLOSED` | 是 |
| `FAILED` | 打开失败，资源已尽力释放 | 否，`open()` 会直接抛错 |

查询入口统一做 `READY` 检查，错误信息带 `details.state`；`manifest`、`state` 与 `capabilities()` 在关闭后仍可读取。

## close() 幂等

```ts
await db.close();
await db.close(); // 直接返回，不重复释放
await db.sql("SELECT 1"); // WeiSQLError: DATABASE_CLOSED
```

并发调用共享同一个关闭 Promise。关闭会统一释放文本索引读取器、ID 索引、`vectorAdapter`、`sqlAdapter`、`resourceReader`，任一释放失败抛 `INTERNAL_ERROR`，但 `state` 仍落到 `CLOSED`。Runtime 拥有注入 Reader 的生命周期，外层不要再单独管理它。

## capabilities()

返回冻结对象，字段全为 `boolean`，只描述当前实例的接线，不是单次调用的承诺。

| 字段 | 为 true 的条件 |
| --- | --- |
| `sql` | 注入了 `sqlAdapter` |
| `vectorExactSearch` | 未注入向量 Adapter 且有 Reader；或 Adapter 的 `capabilities.exactSearch` 为 true |
| `vectorAnnSearch` | 注入了向量 Adapter 且它未声明 `exactSearch` |
| `hybridSearch` | 有 Reader、有 `sqlAdapter`，且未注入向量 Adapter 或它声明精确 |
| `textSearch` | 有 Reader，且 `manifest.textIndexes` 至少有一项 |
| `fusionSearch` | 有 Reader，且存在向量集合或文本索引 |
| `ragSearch` | 有 Reader，且至少一个文本索引声明了 `documents` |
| `resourceRange` | 注入了 `resourceReader` |

`hybridSearch` 的判定包含 `sqlAdapter`，但 `hybrid.search()` 本身不执行 SQL；`textSearch` 为 true 也不保证某个具体索引名存在。

## 打开顺序

1. 检查 `mode`，非 `"readonly"` 抛 `INVALID_ARGUMENT`。
2. 检查 `signal`，已取消抛 `QUERY_CANCELLED`。
3. 检查 `manifestUrl` / `manifest` 是否恰好一个。
4. 有 `manifest` 时直接 `validateManifest()`；否则先 `fetch`、解析 JSON，再校验。
5. 在 `prepare()` 中校验 `verifyChecksums` 取值，需要时先包缓存层。
6. `verifyChecksums` 非 `none` 时执行 L3，此时仍没有 Adapter 接触过资源。
7. `Database.create()`：先检查 Adapter 与 Reader 配对，再按 `sqlAdapter.open()` → `vectorAdapter.open()` 打开，最后复检取消并置为 `READY`。

L3 之前失败时 `open()` 会关闭传入的 Reader；进入 `Database.create()` 后由 Database 自己清理，不会重复关闭。注意 `verifyChecksums` 的取值校验发生在 Manifest 获取与校验之后，不是参数校验的第一步。

## Adapter 注入约束

- 注入 `sqlAdapter` 或 `vectorAdapter` 必须同时提供 `resourceReader`，否则 `INVALID_ARGUMENT`；Adapter 没有独立数据通道。
- 未注入 `sqlAdapter`：`sql()` / `sqlStream()` 抛 `SQL_UNSUPPORTED`，带 `filter` 的向量搜索同样抛 `SQL_UNSUPPORTED`。
- 未注入 `resourceReader`：向量与全文搜索抛 `INDEX_NOT_FOUND`，`verifyChecksums` 非 `none` 抛 `INVALID_ARGUMENT`。
- Adapter 返回过滤范围外的行属于违约，Runtime 抛 `INTERNAL_ERROR`，不会静默放宽结果集。

## 完整 Node 示例

```ts
import { readFile } from "node:fs/promises";
import { open, NodeFileResourceReader } from "@weisql/sdk";
import { createDuckDbAdapter } from "@weisql/duckdb-adapter";

const manifest = JSON.parse(await readFile("./demo/manifest.json", "utf8"));
const db = await open({
  manifest,
  resourceReader: new NodeFileResourceReader({ rootDirectory: "./demo" }),
  sqlAdapter: createDuckDbAdapter({ tableLoading: "memory" }),
  cache: { maxCacheBytes: 16 * 1024 * 1024 },
  verifyChecksums: "all",
});

try {
  console.log(db.state, db.manifest.datasetId, db.capabilities());
  const rows = await db.sql<{ id: string; title: string }>(
    "select id, title from documents where category = ? order by id",
    ["genetics"],
    { maxRows: 100 },
  );
  console.log(rows);
} finally {
  await db.close();
}
```

参数走预处理语句绑定，不要把外部输入拼进 SQL 字符串。

## 常见错误

| 错误码 | 触发场景 |
| --- | --- |
| `INVALID_ARGUMENT` | Manifest 来源不是恰好一个；`mode` 非法；`verifyChecksums` 取值非法；Adapter 缺 Reader；`topK` / `k` / `maxCharacters` 非法；`strategy` 缺 `filter` |
| `MANIFEST_INVALID` | Manifest 结构或跨字段校验失败；Manifest 响应不是合法 JSON |
| `FORMAT_VERSION_UNSUPPORTED` | `formatVersion` 不在支持列表 |
| `RESOURCE_NOT_FOUND` | Manifest 请求非 OK（含 404）或网络失败 |
| `RESOURCE_INTEGRITY_FAILED` | 开启 L3 后尺寸或摘要不符 |
| `SQL_UNSUPPORTED` | 未注入 `sqlAdapter`，或带 `filter` 的向量搜索缺少 SQL 能力 |
| `INDEX_NOT_FOUND` | 向量集合或文本索引名不存在；未注入 Reader |
| `VECTOR_DIMENSION_MISMATCH` | 查询向量长度与 `dimension` 不符 |
| `VECTOR_INVALID_VALUE` | `topK` 非正整数、分量非有限、Cosine 零向量 |
| `QUERY_CANCELLED` | 打开或查询期间 `signal` 被触发 |
| `DATABASE_CLOSED` | 关闭后执行查询 |
| `INTERNAL_ERROR` | 无可用 `fetch`；关闭阶段释放失败；Adapter 越界返回 |

按 `code` 分支处理，不要匹配错误消息文本；`details` 携带 `state`、`status`、`index` 等定位字段。

## 行为边界

- 只读：没有写入、DDL 或事务接口；SQL 的只读边界由 Adapter 负责。
- 打开时不校验 Parquet 内容；列一致性属于 Adapter 的 L4 校验。
- `verifyChecksums: "none"` 不访问任何资源，损坏要到首次查询才暴露。
- 真实 CDN 的 CORS、Range 与缓存命中率未验证，见 [兼容性](/docs/reference/compatibility)。

## 延伸阅读

- [打开数据库与生命周期](/docs/sdk/open-and-lifecycle)
- [错误码速查](/docs/sdk/errors)
- [Readers API](/docs/api/readers)
- [SDK API 契约](https://github.com/fengjutian/WeiSQL/blob/main/docs/SDK_API_CONTRACT_V1.md)
