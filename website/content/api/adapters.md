---
title: Adapter 工厂 API
description: createDuckDbAdapter、createDuckDbWasmAdapter 与 createUSearchAdapter 的完整签名、选项默认值、能力字段和注入示例。
sidebar_position: 76
hero:
  kicker: "API · Adapters"
  title: "三个工厂，一个注入点"
  lead: "DuckDB、DuckDB-Wasm、USearch 的选项与能力。"
  chips: ["createDuckDbAdapter", "createUSearchAdapter"]
hide_title: true
---


本页是三个 Adapter 工厂的 API 参考：它们都返回实现了 SDK 契约的对象，通过 `open({ sqlAdapter })` 或 `open({ vectorAdapter })` 注入。读完后你应该能对照源码选择工厂、填写选项，并正确解读 `capabilities`。

## 共同约束

- 工厂在**构造时**校验选项，非法值立即抛 `INVALID_ARGUMENT`，不会等到 `open()`；
- 注入 Adapter 时必须同时提供 `resourceReader`，否则 `open()` 抛 `INVALID_ARGUMENT`；
- 所有 Adapter 的 `open()` 只能成功调用一次，重复打开抛 `INVALID_ARGUMENT`；
- Runtime 拥有生命周期：`db.close()` 会先关闭 Adapter，再关闭 Reader；
- 查询前的参数、维度、Top-K 与过滤条件由 Runtime 校验，Adapter 只负责执行。

## createDuckDbAdapter()

```ts
function createDuckDbAdapter(options?: DuckDbAdapterOptions): DuckDbSqlAdapter;
```

返回 Node.js 端的 `DuckDbSqlAdapter`，实现 `SqlAdapter`。类本身也从 `@weisql/duckdb-adapter` 导出。

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `tableLoading` | `"memory" \| "lazy"` | `"memory"` | `memory` 物化进内存并关闭外部文件访问；`lazy` 保留视图并开启外部访问 |
| `maxTableBytes` | `number` | 256 MiB | 单表声明字节上限，超过时拒绝物化 |
| `maxTotalTableBytes` | `number` | 512 MiB | 整包声明字节上限，在创建 DuckDB 实例之前检查 |
| `verifyTableSchema` | `boolean` | `true` | 用 `DESCRIBE` 比对 Manifest 列名与类型（L4） |
| `config` | `Record<string, string>` | 未设置 | 创建 `:memory:` 实例时附加的 DuckDB 配置 |

`tableLoading: "lazy"` 只适用于 SQL 完全由应用作者编写的场景：视图需要查询期文件访问，因此 `enable_external_access` 必须保持开启，终端用户 SQL 可以读取本机文件。`memory` 模式则会在建表后关闭外部访问。

| 能力字段 | 值 |
| --- | --- |
| `engine` | `"duckdb"` |
| `engineVersion` | `open()` 后由 `version()` 填充 |
| `parameterBinding` | `true` |
| `parquet` | `true` |
| `supportedFeatures` | `select`、`cte`、`explain`、`describe`、`show`、`summarize`、`parameter-binding`、`single-statement`、`read-only-enforced`，再加 `external-access-disabled`（`memory`）或 `external-file-access-enabled`（`lazy`） |
| `cancellation` | `"native"` |

最小注入示例：

```ts
import { readFile } from "node:fs/promises";
import { open, NodeFileResourceReader } from "@weisql/sdk";
import { createDuckDbAdapter } from "@weisql/duckdb-adapter";

const manifest = JSON.parse(await readFile("./demo/manifest.json", "utf8"));
const db = await open({
  manifest,
  resourceReader: new NodeFileResourceReader({ rootDirectory: "./demo" }),
  sqlAdapter: createDuckDbAdapter({ tableLoading: "memory" }),
});

const rows = await db.sql("select id, title from documents where category = ?", ["genetics"]);
await db.close();
```

## createDuckDbWasmAdapter()

```ts
function createDuckDbWasmAdapter(options: DuckDbWasmAdapterOptions = {}): DuckDbWasmSqlAdapter;
```

返回浏览器端的 `DuckDbWasmSqlAdapter`，实现 `SqlAdapter`。虽然形参有默认空对象，但构造器要求 `bundles` 与 `database` 至少提供一个，两者都缺失时抛 `INVALID_ARGUMENT`。

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `bundles` | `{ mainModule: string; mainWorker: string; pthreadWorker?: string \| null }` | 无 | WASM 模块与 Worker 的 URL；不猜 CDN |
| `database` | `WasmDuckDb` | 无 | 已构建的实例；注入后 Adapter 不创建也不终止它 |
| `maxTableBytes` | `number` | 64 MiB | 单表声明字节上限 |
| `maxTotalTableBytes` | `number` | 128 MiB | 整包声明字节上限，在加载 WASM 之前检查 |
| `verifyTableSchema` | `boolean` | `true` | 比对物化后的 schema 与 Manifest（L4） |
| `extensionRepository` | `string` | 未设置 | 自托管扩展仓库的绝对 URL；未设置时用 `extensions.duckdb.org` |
| `logger` | `"silent" \| "console"` | `"silent"` | 是否把 DuckDB-Wasm 日志转发到控制台 |

`extensionRepository` 必须是 `http:` 或 `https:` 绝对 URL，否则构造时抛 `INVALID_ARGUMENT`。`open()` 会显式 `INSTALL`/`LOAD parquet`；扩展加载失败抛 `SQL_UNSUPPORTED`，不会静默降级。

| 能力字段 | 值 |
| --- | --- |
| `engine` | `"duckdb-wasm"` |
| `engineVersion` | `open()` 后由 `version()` 填充 |
| `parameterBinding` | `true` |
| `parquet` | `true` |
| `supportedFeatures` | `select`、`explain`、`describe`、`show`、`summarize`、`parameter-binding`、`single-statement`、`read-only-keyword-enforced`、`external-access-disabled`；tokenizer 可用时再加 `cte` |
| `cancellation` | `"best-effort"` |

最小注入示例：

```ts
import { open, HttpResourceReader } from "@weisql/sdk";
import { createDuckDbWasmAdapter } from "@weisql/duckdb-wasm-adapter";

const db = await open({
  manifestUrl: "/datasets/demo/manifest.json",
  resourceReader: new HttpResourceReader({ baseUrl: "/datasets/demo/" }),
  sqlAdapter: createDuckDbWasmAdapter({
    bundles: {
      mainModule: "/vendor/duckdb/duckdb-eh.wasm",
      mainWorker: "/vendor/duckdb/duckdb-browser-eh.worker.js",
    },
  }),
});
```

## createUSearchAdapter()

```ts
function createUSearchAdapter(options?: USearchAdapterOptions): VectorAdapter;
```

返回基于 USearch HNSW 的近似向量 Adapter。它只接受已解析的集合描述符、查询、Top-K 与允许行集合，不访问 SQL。

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `connectivity` | `number` | `16` | HNSW 图度数 |
| `expansionAdd` | `number` | `128` | 插入时的候选列表大小 |
| `expansionSearch` | `number` | `512` | 搜索时的候选列表大小；召回依赖它 |
| `buildBatchRows` | `number` | `4096` | 构建索引时每批加入的行数 |
| `filtering` | `"reject" \| "post-filter"` | `"reject"` | 带允许行集合时的策略 |
| `filterOversample` | `number` | `8` | post-filter 的候选倍数 |

所有数值选项必须是正安全整数，`filtering` 只取上述两值，否则抛 `INVALID_ARGUMENT`。

| 能力字段 | 值 |
| --- | --- |
| `engine` | `"usearch"` |
| `metrics` | `["cosine", "l2", "ip"]` |
| `persistedIndex` | `true`；Manifest 声明 `index` 时加载，否则首次搜索现场构建 |
| `metadataFiltering` | `false` |
| `postFiltering` | `filtering === "post-filter"` |
| `exactSearch` | `false` |
| `cancellation` | `"unsupported"` |

`filtering: "reject"` 时，只要 Runtime 传入 `allowedRows` 就抛 `SQL_UNSUPPORTED`；`"post-filter"` 会扩大候选窗口直到凑够 Top-K 或遍历完集合，但结果**按构造不完整**，命中数可能少于 Top-K，`diagnostics.postFiltered` 为 `true`。

最小注入示例：

```ts
import { readFile } from "node:fs/promises";
import { open, NodeFileResourceReader } from "@weisql/sdk";
import { createUSearchAdapter } from "@weisql/usearch-adapter";

const manifest = JSON.parse(await readFile("./demo/manifest.json", "utf8"));
const db = await open({
  manifest,
  resourceReader: new NodeFileResourceReader({ rootDirectory: "./demo" }),
  vectorAdapter: createUSearchAdapter({ expansionSearch: 512 }),
});

const hits = await db.vector.search("document_embeddings", [1, 0], { topK: 10 });
await db.close();
```

## SqlAdapter 契约

| 成员 | 签名 |
| --- | --- |
| `capabilities` | `Readonly<SqlAdapterCapabilities>` |
| `open` | `(context: SqlAdapterOpenContext) => Promise<void>` |
| `query` | `<T>(statement: string, parameters?: readonly SQLValue[], options?: QueryOptions) => Promise<readonly T[]>` |
| `stream` | 可选；`<T>(statement, parameters?, options?) => Promise<AsyncIterable<T>>` |
| `close` | `() => Promise<void>` |

`SqlAdapterOpenContext` 的字段是 `manifest`、`reader` 与可选 `signal`。`stream()` 缺失时 Runtime 退回 `query()` 并把已物化的行包装成异步迭代器。

| 能力字段 | 类型 | 含义 |
| --- | --- | --- |
| `engine` | `string` | 引擎名，用于诊断 |
| `engineVersion` | `string?` | 引擎版本；通常在 `open()` 后填充 |
| `parameterBinding` | `boolean` | 是否通过预处理语句绑定参数 |
| `parquet` | `boolean` | 是否能读取 Parquet |
| `supportedFeatures` | `readonly string[]` | 引擎支持的语句与边界特性 |
| `cancellation` | `"native" \| "best-effort" \| "unsupported"` | 中断执行中的查询的能力 |

## VectorAdapter 契约

| 成员 | 签名 |
| --- | --- |
| `capabilities` | `Readonly<VectorAdapterCapabilities>` |
| `open` | `(context: VectorAdapterOpenContext) => Promise<void>` |
| `search` | `(request: VectorAdapterSearchRequest) => Promise<readonly VectorHit[]>` |
| `close` | `() => Promise<void>` |

`VectorAdapterSearchRequest` 的字段是 `vector`（已解析的集合描述符）、`query: Float32Array`、`topK: number` 与可选 `allowedRows: ReadonlySet<number>`、`signal`。Adapter 不解析集合名，也不执行 SQL。

| 能力字段 | 类型 | 含义 |
| --- | --- | --- |
| `engine` | `string` | 引擎名 |
| `engineVersion` | `string?` | 引擎版本 |
| `metrics` | `readonly VectorMetric[]` | 支持的 `cosine`、`l2`、`ip` 子集 |
| `persistedIndex` | `boolean` | 是否加载 Manifest 声明的持久化索引 |
| `metadataFiltering` | `boolean` | 是否自行实现 V1 过滤语义 |
| `postFiltering` | `boolean` | 是否接受近似窗口上的后过滤；结果不完整 |
| `exactSearch` | `boolean` | 只有真正暴力扫描才可为 `true` |
| `cancellation` | `"native" \| "best-effort" \| "unsupported"` | 中断搜索的能力 |

## 工厂选择

| 场景 | 工厂 | 关键取舍 |
| --- | --- | --- |
| Node.js 执行 SQL | `createDuckDbAdapter()` | 原生取消、L4；内存成本随表大小 |
| 浏览器执行 SQL | `createDuckDbWasmAdapter()` | 需 Worker/WASM 与 parquet 扩展；取消为 best-effort |
| 需要近似向量检索 | `createUSearchAdapter()` | 召回由参数决定，结果声明 `exact: false` |
| 需要 SDK 内置精确检索 | `createExactVectorAdapter()` | 参考实现，`exactSearch: true`；过滤由 Runtime 解析 |

带过滤的向量查询要求 Adapter 的 `exactSearch` 或 `postFiltering` 为 `true`，否则 Runtime 在调用 Adapter 前抛 `SQL_UNSUPPORTED`。`strategy: "vector-first"` 只在 SDK 内置精确管线可用，注入 Adapter 后同样被拒绝。若 Adapter 返回 `allowedRows` 之外的行，Runtime 抛 `INTERNAL_ERROR`。

## 延伸阅读

- `/docs/adapters/duckdb`：Node.js DuckDB 的表加载、SQL 边界与错误归一化。
- `/docs/adapters/duckdb-wasm`：浏览器端的 Worker、扩展托管与参数限制。
- `/docs/adapters/usearch`：HNSW 参数、召回测量与后过滤。
- `/docs/sdk/open-and-lifecycle`：注入点、Reader 归属与关闭顺序。
