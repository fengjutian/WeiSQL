---
title: 环境与引擎兼容性
description: 对照 Node.js 与浏览器、DuckDB 与 DuckDB-Wasm 在取消、参数、扩展和内存预算上的差异，说明哪些结论可以外推。
sidebar_position: 52
hero:
  kicker: "参考 · 兼容性"
  title: "Node 与浏览器，能力不等价"
  lead: "结果语义一致，但参数、取消、扩展与预算不同。"
  chips: ["Node", "Chromium", "cancel"]
hide_title: true
---


“同一份 SDK 代码”不等于“同一套能力”。本页把差异摊开，方便你在选运行时之前就知道会踩到什么。

一句话结论：**公开语义在两端一致，能力边界不一致**。排序、ID、错误码经过逐字段对照；参数类型、取消强度、扩展分发和内存预算各有取舍。

## 平台支持

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Node.js 20+ | 已测试 | 仓库在 Node 24 上开发，最低要求 20；CI 覆盖 Ubuntu 与 Windows |
| Chromium（Chrome / Edge） | 已做探针 | Playwright 驱动 Chromium 1248 |
| Firefox / Safari | 未验证 | 未跑探针，不承诺行为 |
| 真实静态托管（CDN） | 未验证 | 需要部署后验收 CORS、Range 与缓存 |

Node 20 是最低要求。低于 20 的版本没有测试，也不在支持范围内。

## Node.js 与浏览器

| 维度 | Node.js | 浏览器 |
| --- | --- | --- |
| 最低要求 | Node.js 20+ | Chromium（Chrome / Edge）；其他内核未系统验证 |
| 数据来源 | `NodeFileResourceReader` 或 `HttpResourceReader` | `HttpResourceReader`、`ContainerReader`、`StreamingContainerReader` |
| 随机读取 | 文件句柄 + 偏移 | HTTP Range（必须 `206`） |
| SQL 引擎 | DuckDB 原生绑定（`@duckdb/node-api` 2.x） | DuckDB-Wasm + Worker |
| 原生依赖 | 需要平台预编译绑定 | 不适用，纯 WASM |
| 首次加载 | 随 `npm install` 获取绑定 | 约 34 MB WASM，另有 parquet 扩展 |
| 默认单表预算 | 256 MiB | 64 MiB |
| 默认整包预算 | 512 MiB | 128 MiB |
| 取消强度 | 原生中断 | `best-effort`，引擎可能继续跑 |
| 扩展分发 | 由驱动负责，无浏览器 CORS 问题 | 必须同源自托管 |
| 持久化 | 由调用方决定 | OPFS opt-in（`persistToOpfs`），第二个标签页回退内存 |

浏览器端的 SQL 不是“Node 端能力的一个子集”这么简单：它的只读边界实现方式不同，因此拒绝的语句形态与错误细节也不同。

## DuckDB 与 DuckDB-Wasm

| 维度 | DuckDB（Node） | DuckDB-Wasm（浏览器） |
| --- | --- | --- |
| 只读边界依据 | `prepare()` 返回的 `StatementType` 必须是 `SELECT` / `EXPLAIN` | 首关键字白名单 + tokenizer 分类 CTE + 单语句扫描 |
| 多语句 | `prepare()` 直接拒绝 | 扫描字符串、注释与 dollar-quoted 后判定 |
| 只读 CTE | 引擎分类天然支持 | 依赖 tokenizer；不可用时退回严格白名单，`WITH` 被拒 |
| `DESCRIBE` / `SHOW` / `SUMMARIZE` | 分类为 `SELECT`，可用 | 白名单放行，可用 |
| `PIVOT` / `UNPIVOT` | 由引擎语义决定 | 白名单显式放行 |
| 外部文件访问 | `enable_external_access=false` | 同样关闭，且 `lock_configuration=true` |
| 表来源 | SDK 读取字节 → 临时文件 → `CREATE TABLE ... AS SELECT` | SDK 读取字节 → `registerFileBuffer` → 物化 → `dropFile` |
| 参数类型 | 字符串、数字、布尔、`null`、`bigint`、`Date`、`Uint8Array` | 字符串、数字、布尔、`null`、安全范围内 `bigint`；`Date` 与二进制被拒绝 |
| 超范围整数 | 直接绑定 | `INVALID_ARGUMENT`，不静默丢精度 |
| `DECIMAL` | 驱动转 `number`，超过 15 位有效数字丢精度 | `castDecimalToDouble` 后同样丢精度 |
| `BIGINT` | `bigint` | `bigint` |
| `BLOB` | `Uint8Array`（Buffer 被转换） | `Uint8Array`（复制，不泄漏 Arrow 缓冲） |
| `maxRows` 语义 | 超限 `INVALID_ARGUMENT`，不截断 | 同左 |
| 可包装语句 | `SELECT` / `VALUES` / `TABLE` 改写为带 `LIMIT maxRows + 1` | 同左 |
| 不可包装语句 | `EXPLAIN` 返回后检查 | `DESCRIBE` / `SHOW` / `SUMMARIZE` / `EXPLAIN` / `PIVOT` / `UNPIVOT` 返回后检查 |
| 取消 | `connection.interrupt()`，原生 | 立即返回 `QUERY_CANCELLED`，但引擎不保证停 |
| 扩展 | 由原生驱动加载 | parquet 扩展必须自托管，版本须与 WASM 核心一致 |
| 引擎版本上报 | `version()` | `version()` |
| L4 校验 | 默认开启，`verifyTableSchema: false` 可关 | 默认开启，规则与 Node 一致 |

### 取消

Node 的取消是**原生**的：abort 触发 `connection.interrupt()`，执行中的查询以 `QUERY_CANCELLED` 结束，连接之后仍可继续使用。

浏览器是**best-effort**：abort 后调用方立刻收到 `QUERY_CANCELLED`（带 `details.engineMayStillRun: true`），但单线程 Worker 里正在跑的 CPU 密集查询不会被抢占。实测一个 202 ms 的查询在第 50 ms abort，调用方 51 ms 就返回，而引擎仍把查询跑完；同一时刻 `cancelSent()` 返回 `false`。

因此浏览器端不要把“取消”当作资源回收手段，它只保证你不再等待。

### 参数

浏览器端的参数经 `JSON.stringify` 送进 Worker，所以只支持 JSON 可表达的标量：

| 参数 | Node | 浏览器 |
| --- | --- | --- |
| `string` / `number` / `boolean` / `null` | 支持 | 支持 |
| 安全范围内 `bigint` | 支持 | 收窄为 `number` |
| 超出安全整数 `bigint` | 支持 | `INVALID_ARGUMENT` |
| `Date` | 支持（UTC 微秒） | 拒绝，提示改传 ISO 字符串 |
| `Uint8Array` | 支持（BLOB） | 拒绝 |
| 对象 | 不支持 | 拒绝 |

需要对时间过滤时，用 ISO 字符串比较，或在 SQL 里显式 `CAST`。

### 扩展与部署

浏览器端的 parquet 扩展不在 npm 包的 WASM 里，运行时才加载，并且 `extensions.duckdb.org` 不返回 CORS 头，页面无法跨域下载。所以必须自托管：

```text
/extensions/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm
```

`npm run vendor:wasm-extension` 会按 WASM 核心版本把扩展缓存下来。未配置 `extensionRepository` 时 `open()` 返回 `SQL_UNSUPPORTED`（`phase: "extension"`），不会静默降级。

Node 端没有这个问题，但换来了原生绑定：`@duckdb/node-api` 提供 win32-x64 / linux-x64 / darwin 预编译包，浏览器无法使用。

### 内存预算

两种适配器都按“声明字节”拦截，不是内存承诺：

- Node：单表 `maxTableBytes` 默认 256 MiB，整包 `maxTotalTableBytes` 默认 512 MiB；整包检查先于实例创建。表会被物化进内存，成本约等于表数据量。
- 浏览器：默认 64 MiB / 128 MiB；整包检查在加载 WASM 之前完成，否则多张大表仍能申请巨量内存。

在 Node 里跑同一 WASM 构建的物化基准显示 RSS 增量约为 Parquet 的 4 倍（50 万行、18.8 MB Parquet、约 +76 MB）。浏览器还要加 Worker 与 DOM 开销，这个比例不能直接当浏览器承诺。

## 什么是一致的

`npm run probe:parity` 在同一个进程里驱动 Node 与 Chromium，逐字段比较：

- 向量 `ids`、`rows` 必须完全相等，`distances` 容差 `1e-6`；
- BM25 `scores` 容差 `1e-9`；
- `diagnostics.exact` 与 `backend` 必须相等；
- RAG 的 `ids` / `texts` / `ranks` / `truncated` / `usedCharacters` / `droppedHits` 必须相等；
- SQL 行结果逐行逐字段相等，写语句、多语句、未知列、写 CTE 的错误码相等；
- 非法 Manifest 的错误码相等。

当前结果是 8 个向量查询 + 5 个全文查询 + 9 个 SQL 查询 + RAG + 1 个容器 + 6 个非法 Manifest 全部匹配。

## 什么不能外推

- 对照只用 2 维、3 条记录的 fixture，不能证明高维或大数集下一致；
- 不比较取消行为，两次实现强度不同；
- 不比较性能，只比较结果；
- 两端用同一份本地静态服务器，真实 CDN 的 CORS、Range 与缓存未覆盖；
- 混合过滤不在 parity 集合内，但 `probe:wasm` 与 `probe:playground` 断言了浏览器端 `exact-filter-first`；
- 容器只覆盖 3.6 KB 的包，大容器未测。

## 怎么选

| 场景 | 建议 |
| --- | --- |
| 构建脚本、离线处理、批量查询 | Node.js，取消与参数支持都更完整 |
| 纯浏览器产品，SQL 由应用作者控制 | DuckDB-Wasm，注意 34 MB 首载与扩展自托管 |
| 终端用户可输入 SQL | 只用 `memory` 模式 + 浏览器白名单；不要让 `lazy` 出现在不可信输入路径 |
| 只做向量 / 全文 / RAG | 可以不注入任何 Adapter，SDK 自带检索 |
| 需要时间戳或二进制参数 | 目前优先选 Node |
| 需要 ANN 且能接受召回不确定 | USearch Adapter，必须用目标数据先测 Recall@K |

相关页面：[DuckDB Adapter](/docs/adapters/duckdb)、[DuckDB-Wasm Adapter](/docs/adapters/duckdb-wasm)、[已知限制](/docs/reference/limitations)。
