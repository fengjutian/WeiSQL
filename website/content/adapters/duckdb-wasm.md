---
title: DuckDB-Wasm Adapter（浏览器）
description: 在浏览器中通过 DuckDB-Wasm 执行只读 SQL，理解同源扩展托管、只读白名单、参数限制与 best-effort 取消。
sidebar_position: 31
---

`@weisql/duckdb-wasm-adapter` 把 DuckDB-Wasm 的 Worker 接到同一个 `SqlAdapter` 接口，让 `db.sql()` 在浏览器里查询数据包。读完本页你应当能部署同源 `parquet` 扩展、判断一条 SQL 会不会被拒绝，并解释浏览器端取消为什么只是 best-effort。

它不是「装个包就完事」：`parquet` 扩展不在 npm 包的 WASM 里，运行时要单独加载；上游 `extensions.duckdb.org` 不返回 CORS 头；DuckDB-Wasm 也不暴露 prepared statement 的 `StatementType`。适配器用「扩展自托管 + 关键字白名单 + 关闭外部访问」应对这三条约束。

## 最小示例

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
    extensionRepository: `${location.origin}/extensions`,
  }),
});

const rows = await db.sql(
  "select id, title from documents where category = ?",
  ["genetics"],
  { maxRows: 50 },
);
```

WASM 模块、Worker 与扩展都要由站点自己托管。扩展可以按下面的命令缓存到本地，再部署到站点：

```bash
npm run vendor:wasm-extension
# 产物：.cache/duckdb-wasm-extensions/<version>/wasm_eh/parquet.duckdb_extension.wasm
```

部署后的路径形如 `/extensions/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm`，`extensionRepository` 指向 `/extensions`。首次页面加载还要拉约 34 MB 的 WASM，扩展体积实测为 498,915 B（`wasm_eh`，v1.4.3）。

## 选项

| 选项 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `bundles.mainModule` | `string` | 必填 | WASM 模块 URL |
| `bundles.mainWorker` | `string` | 必填 | Worker 脚本 URL |
| `bundles.pthreadWorker` | `string \| null` | 未设置 | 可选的多线程 Worker；当前 COI 路径不可用 |
| `extensionRepository` | `string` | 未设置 | 自托管扩展仓库基 URL；省略时尝试上游 |
| `maxTableBytes` | `number` | 64 MiB | 单表声明字节上限 |
| `maxTotalTableBytes` | `number` | 128 MiB | 整包上限，在加载 WASM 之前检查 |
| `verifyTableSchema` | `boolean` | `true` | 物化后比对 Manifest 的列名与类型（L4） |
| `database` | `WasmDuckDb` | 未设置 | 注入已有实例；提供后适配器不创建也不终止它 |
| `logger` | `"silent" \| "console"` | `"silent"` | 是否把 DuckDB-Wasm 日志转发到控制台 |

`database` 是测试与「应用已经拥有 AsyncDuckDB」场景的接缝。普通页面不需要传它。

## 行为与边界

### 数据路径

```text
Manifest
  → Runtime（L1/L2，可选 L3）
  → ResourceReader.read(table.file.path)
  → registerFileBuffer(...)
  → CREATE TABLE ... AS SELECT * FROM read_parquet(?)
  → dropFile(...)
  → enable_external_access=false
  → lock_configuration=true
```

DuckDB 不直接访问数据包 URL，表数据来自 SDK 的 Reader。Range、缓存与 L3 摘要校验仍然只有一条路径，不会出现「SQL 绕过完整性校验」的缺口。物化完成后立即释放 VFS 里的 Parquet 副本。

### 只读边界

浏览器端拿不到引擎的语句分类，因此用多层规则：

| 层 | 做法 | 挡住什么 |
| --- | --- | --- |
| 关键字白名单 | 只放行 `SELECT`、`EXPLAIN`、`DESCRIBE`、`SHOW`、`SUMMARIZE`、`PIVOT`、`UNPIVOT`、`TABLE`、`VALUES` | 写入、DDL、`SET`、`ATTACH`、`LOAD`、`INSTALL`、`COPY`、事务 |
| CTE 分类 | 用 DuckDB 自己的 tokenizer 跳过 CTE 列表，再判定真正的动词 | `with x as (...) delete from t` |
| 单语句扫描 | 识别字符串、标识符、注释与 dollar-quoted 文本后的 `;` | `select 1; delete from t` |
| 外部访问 | `enable_external_access=false` | 用户 SQL 里的 `read_parquet('/etc/passwd')` |
| 配置锁 | `lock_configuration=true` | 查询期重新打开外部访问 |

`WITH` 的首关键字不能说明语句类型。`AsyncDuckDB.tokenize()` 返回 UTF-8 字节偏移，适配器先映射再切片，跳过 `[RECURSIVE] name [(cols)] [MATERIALIZED] AS (...)` 后看下一个关键字；只有后面是 `SELECT`、`VALUES`、`TABLE` 等只读动词才放行。结构无法识别（括号不闭合、缺 `AS`、CTE 后直接跟 `(`）时 fail closed。

tokenizer 不可用或抛错时退回严格白名单，此时 `WITH` 被拒绝，且 `capabilities().supportedFeatures` 不含 `cte`。

### 参数与结果映射

参数经 `AsyncPreparedStatement.query(...values)` 绑定，但 DuckDB-Wasm 会用 `JSON.stringify` 送进 Worker，所以只接受 JSON 可表达的标量：

| 参数 | 行为 |
| --- | --- |
| `string` / `number` / `boolean` / `null` | 支持 |
| 安全范围内的 `bigint` | 收窄为 `number` |
| 超出安全整数的 `bigint` | `INVALID_ARGUMENT`，不允许静默丢精度 |
| `Date` / `Uint8Array` / 对象 | `INVALID_ARGUMENT`，提示改传 ISO 字符串 |

结果侧：`BIGINT` 返回 `bigint`；`DECIMAL` 打开时 `castDecimalToDouble`，返回 `number`，超过 15 位有效数字会丢精度；`TIMESTAMP` 返回 `Date`；`BLOB` 返回复制后的 `Uint8Array`；`INTEGER`、`DOUBLE`、`BOOLEAN`、`VARCHAR`、`NULL` 原样返回。

### 行数预算

`maxRows` 与 Node 适配器语义相同：超限抛 `INVALID_ARGUMENT`（`details.maxRows`），不截断。`SELECT`、`VALUES`、`TABLE` 会被包装成 `SELECT * FROM (<sql>) ... LIMIT maxRows + 1`，由 WASM 引擎提前停止；`DESCRIBE`、`SHOW`、`SUMMARIZE`、`EXPLAIN`、`PIVOT`、`UNPIVOT` 无法安全包装，在返回后检查。

### 内存与预算

表在 `open()` 时物化，峰值内存约为「Parquet 字节 + 表数据」。`bench:wasm` 在 Node 里测到 RSS 增量约为 Parquet 的 4 倍，因此浏览器默认预算比 Node 更紧：单表 64 MiB、整包 128 MiB，整包检查发生在加载 WASM 之前。`maxTableBytes` 只是拒绝阈值，不是内存保证。

### 取消

`cancellation: "best-effort"`：

- 查询前已 abort → `QUERY_CANCELLED`，不会发给引擎；
- 查询中 abort → 调用方立即收到 `QUERY_CANCELLED`（`details.engineMayStillRun: true`），适配器不等待 Worker；
- 同时 fire-and-forget 调用 `connection.cancelSent()`，但它不能抢占单线程 Worker 里正在执行的 CPU 密集查询。

实测（Chromium 1248）：一条完整执行 202 ms 的查询，在第 50 ms abort，调用方 51 ms 返回 `QUERY_CANCELLED`；同一时刻 `cancelSent()` 返回 `false`。要真正抢占需要 pthreads/COI 多线程构建，当前不可用。

### 实测数字

| 指标 | 数值 | 条件 |
| --- | --- | --- |
| `open()`（实例化 + 扩展 + 物化 + L4） | 1.37–1.70 s | Chromium 1248，fixture 3 行，扩展同源且已缓存 |
| 参数化查询 | < 50 ms | 同上，3 行表 |
| 只读 CTE / 写 CTE | 前者返回结果，后者 `SQL_UNSUPPORTED` | `probe:wasm` 断言 |
| Node ↔ Chromium SQL | 9 个查询与错误码一致 | `probe:parity` |

这些数字只说明「能跑通、量级合理」，不构成性能承诺。上述场景之外的冷启动、浏览器内大表与真实网络都未测量。

### 与 Node 适配器的差异

| 维度 | Node DuckDB | 浏览器 DuckDB-Wasm |
| --- | --- | --- |
| 只读判定 | 引擎 `StatementType` | 关键字白名单 + tokenizer 判定的 CTE |
| 参数 | 支持 `Date`、`Uint8Array` | 仅 JSON 标量，`Date`/二进制拒绝 |
| 取消 | `native`，`connection.interrupt()` | `best-effort`，引擎可能继续执行 |
| 默认预算 | 单表 256 MiB / 整包 512 MiB | 单表 64 MiB / 整包 128 MiB |
| 扩展 | 无 | `parquet` 必须同源自托管 |

两端都叫 DuckDB，但能力边界不同；不要把 Node 端的参数类型或取消语义直接搬到浏览器。

### 未验证与明确不做

- 浏览器冷启动与 500k 行以上的内存：`bench:wasm` 是 Node 里的同一 WASM 构建，不是浏览器测量；
- OPFS 持久化与 `pthread` 路径；
- `Date`、二进制参数与结构化错误位置；
- COI / 多线程：试过，不可用。`duckdb-coi.wasm` 能跑，但加载 `parquet` 扩展直接 `LinkError`，`wasm_threads` 变体同样如此；
- 非 `SELECT` 的只读 CTE 形态按 fail-closed 拒绝，未逐一支持；
- CDN 上的扩展 CORS 配置：本实现要求同源自托管。

## 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `SQL_UNSUPPORTED`，`phase: "extension"` | 扩展未自托管或 CORS 失败 | 部署 `/extensions/<version>/wasm_eh/`，设置 `extensionRepository` |
| `SQL_UNSUPPORTED` | 写入、DDL、`SET`、`WITH ... DELETE`、多语句 | 改只读查询；CTE 只用于只读语句 |
| `INVALID_ARGUMENT` | 传了 `Date`、二进制、超范围 `bigint` | 改传 ISO 字符串或安全整数 |
| `QUERY_CANCELLED` 但引擎仍占用 | best-effort 取消，Worker 未停 | 不要假设资源已释放；避免在长查询后立刻重查询 |
| `RESOURCE_INTEGRITY_FAILED` | L4 列名/类型不一致，或 L3 校验失败 | 修 Manifest/Parquet，重新 `validate --l4` |
| 页面白屏或 `LinkError` | 用了 COI 多线程构建 | 回到单线程 `wasm_eh` 构建 |

## 延伸阅读

- [DuckDB Adapter（Node.js）](/docs/adapters/duckdb)：同一 SQL 契约的 Node 实现与差异。
- [SQL 查询](/docs/sdk/sql)：`db.sql()` 的通用语义。
- [部署到 CDN](/docs/tooling/deploy-cdn)：静态托管、Range 与 CORS。
- [兼容性](/docs/reference/compatibility)：浏览器与 Node 的能力矩阵。
- [能力与限制](/docs/reference/limitations)：当前未验证项。
- [DuckDB-Wasm Adapter 设计](https://github.com/fengjutian/WeiSQL/blob/main/docs/DUCKDB_WASM_ADAPTER.md)。
- [跨环境对照](https://github.com/fengjutian/WeiSQL/blob/main/docs/ENVIRONMENT_PARITY.md)。
