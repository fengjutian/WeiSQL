---
title: DuckDB Adapter（Node.js）
description: 在 Node.js 中把只读 DuckDB 接入 WeiSQL Runtime，理解物化方式、只读边界、参数绑定与取消语义。
sidebar_position: 30
hero:
  kicker: "适配器 · Node"
  title: "把 DuckDB 接到只读 Runtime"
  lead: "表从 Reader 字节物化，只读边界由语句分类保证。"
  chips: ["memory", "lazy", "L4", "native"]
hide_title: true
---


`@weisql/duckdb-adapter` 把 Node.js 端的 DuckDB 接到 SDK 的 `SqlAdapter` 接口上，让 `db.sql()` 执行真实 SQL，同时保持只读边界。读完后你应当能选对表加载模式、正确绑定参数，并解释一次查询为什么被拒绝。

SDK 本身不依赖任何 SQL 引擎，这个包通过 `open({ sqlAdapter })` 注入。它只适用于 Node.js 20+，依赖 `@duckdb/node-api` 的原生预编译绑定，不能用于浏览器；浏览器请用 [DuckDB-Wasm Adapter](/docs/adapters/duckdb-wasm)。

## 最小示例

以下按发布后的包名书写。仓库当前尚未发布 npm 包，本地运行需先构建，参见 [快速开始](/docs/start/quickstart)。

```ts
import { readFile } from "node:fs/promises";
import { open, NodeFileResourceReader } from "@weisql/sdk";
import { createDuckDbAdapter } from "@weisql/duckdb-adapter";

const manifest = JSON.parse(await readFile("./demo/manifest.json", "utf8"));

const db = await open({
  manifest,
  resourceReader: new NodeFileResourceReader({ rootDirectory: "./demo" }),
  sqlAdapter: createDuckDbAdapter({
    tableLoading: "memory",
    maxTableBytes: 256 * 1024 * 1024,
    verifyTableSchema: true,
  }),
  verifyChecksums: "all",
});

const rows = await db.sql(
  "select id, title from documents where category = ? order by id",
  ["genetics"],
  { maxRows: 100 },
);

console.log(rows);
await db.close();
```

参数走预处理语句绑定，不要把用户输入拼进 SQL 字符串。

## 选项

| 选项 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `tableLoading` | `"memory" \| "lazy"` | `"memory"` | 表以物化表还是临时文件视图进入 DuckDB |
| `maxTableBytes` | `number` | 256 MiB | 单表声明字节上限，超过则拒绝物化 |
| `maxTotalTableBytes` | `number` | 512 MiB | 整包声明字节上限，在创建 DuckDB 实例之前检查 |
| `verifyTableSchema` | `boolean` | `true` | 用 `DESCRIBE` 比对 Manifest 的列名与类型（L4） |
| `config` | `Record<string, string>` | 未设置 | 创建内存实例时附加的 DuckDB 配置 |

两种加载模式的取舍：

| 模式 | 内存 | 外部文件访问 | 适用场景 |
| --- | --- | --- | --- |
| `memory` | 约等于表数据量 | 关闭 | 任何 SQL，包括终端用户输入 |
| `lazy` | 受 row group 控制 | **开启** | SQL 由应用作者编写 |

`lazy` 仍拒绝写入与 DDL，但它挡不住读取：用户 SQL 里的 `read_parquet('C:/Windows/win.ini')` 会成功。完整对比见 [表加载模式](https://github.com/fengjutian/WeiSQL/blob/main/docs/TABLE_LOADING_OPTIONS.md)。

```ts
// 仅当 SQL 完全由应用作者编写时使用
const adapter = createDuckDbAdapter({ tableLoading: "lazy" });
```

## 能力声明

`db.capabilities().sql` 为 `true`；适配器自身的能力声明可以进一步区分两种加载模式：

| 字段 | `memory` | `lazy` |
| --- | --- | --- |
| `engine` | `"duckdb"` | `"duckdb"` |
| `parameterBinding` / `parquet` | `true` / `true` | `true` / `true` |
| `cancellation` | `"native"` | `"native"` |
| `supportedFeatures` | 基础项 + `external-access-disabled` | 基础项 + `external-file-access-enabled` |

基础项包括 `select`、`cte`、`explain`、`describe`、`show`、`summarize`、`parameter-binding`、`single-statement`、`read-only-enforced`。`engineVersion` 来自引擎的 `version()`，不是从包名推断。

## 行为与边界

### 打开流程

1. 先核对整包声明字节数是否超过 `maxTotalTableBytes`，超预算时实例和临时目录都尚未创建；
2. 创建 `:memory:` 实例并建立连接；
3. 逐表从 `ResourceReader` 读取字节，核对长度等于 Manifest 声明值；
4. 写入临时目录并执行 `CREATE TABLE ... AS SELECT * FROM read_parquet(?)`，随后删除临时文件；
5. 按 `DESCRIBE` 比对列名与类型（L4）；
6. 设置 `enable_external_access=false` 与 `lock_configuration=true`，读取 `version()` 填充 `engineVersion`。

任一步失败都会关闭连接、释放实例并删除临时目录，状态转为 `FAILED`。

### 只读边界

- 边界来自解析后的 `StatementType`，只接受 `SELECT` 与 `EXPLAIN`；
- `INSERT`、`UPDATE`、`DELETE`、`COPY`、`CREATE`、`ALTER`、`DROP`、`SET`、写 `PRAGMA` 全部返回 `SQL_UNSUPPORTED`；
- `WITH ... DELETE` 这类伪装写法同样被拒，因为分类发生在解析之后；
- `DESCRIBE`、`SHOW`、`SUMMARIZE`、`PRAGMA table_info(...)` 在 DuckDB 中分类为 `SELECT`，因此可用；
- `CALL` 属于独立类型，返回 `SQL_UNSUPPORTED`；
- `prepare()` 直接拒绝多语句输入，一次调用无法夹带第二条语句；
- 关闭外部访问后，文件与网络函数失效，`read_parquet('/etc/passwd')` 不再可用。

### 参数与结果映射

| 输入 `SQLValue` | 绑定方式 |
| --- | --- |
| `null` / `string` / `number` / `boolean` / `bigint` | 直接绑定 |
| `Date` | 按 UTC 微秒解释为 timestamp |
| `Uint8Array` | 作为 BLOB 绑定 |

结果侧：`BIGINT`、`HUGEINT` 返回 `bigint`；数值类型返回 `number`；`TIMESTAMP`、`DATE` 返回 `Date`；`BLOB` 返回 `Uint8Array`；`STRUCT`、`LIST`、`MAP` 递归转换。已知限制：`DECIMAL` 由驱动转成 `number`，超过 15 位有效数字会丢精度；`INTERVAL`、`UNION`、`BIT` 未做专门映射，属于未验证能力。

### 行数预算与 L4

`db.sql(sql, params, { maxRows })` 超过预算时返回 `INVALID_ARGUMENT`（`details.maxRows`），不会静默截断。普通 `SELECT` 会被改写为带 `LIMIT maxRows + 1` 的子查询，让引擎提前停止；`EXPLAIN` 无法包装，在返回后检查。只读分类仍针对原始语句执行，改写不会放松写入边界。

L4 只比对列名与类型，不比对可空性，因为 `read_parquet` 不保留 `NOT NULL` 约束，`DESCRIBE` 对声明非空列也返回 `YES`。

### 取消与生命周期

取消是原生的：`AbortSignal` 触发 `connection.interrupt()`，执行中的查询以 `QUERY_CANCELLED` 结束，测试中约 50–100 ms 返回，中断后连接仍可继续使用。`close()` 幂等；关闭后 `query()` 返回 `DATABASE_CLOSED`；重复 `open()` 返回 `INVALID_ARGUMENT`。

### 错误归一化

引擎错误在 Adapter 边界转换为稳定错误码，调用方只需要依赖 `code`：

| 引擎信号 | 归一化错误码 |
| --- | --- |
| `INTERRUPT` | `QUERY_CANCELLED` |
| 多语句 | `SQL_UNSUPPORTED` |
| `Permission Error` 或文件访问被禁 | `SQL_UNSUPPORTED` |
| `Parser` / `Binder` / `Catalog` / `Conversion Error` | `INVALID_ARGUMENT` |
| 其他 | `INTERNAL_ERROR` |

错误详情包含阶段（`open` / `prepare` / `execute`）、引擎名与截断到 300 字符的引擎摘要；不附带完整 SQL 或参数值。

### 测试覆盖

`packages/duckdb-adapter/test/adapter.test.js` 覆盖能力声明、真实表查询、参数绑定与非插值、类型映射、写入/DDL/配置/`CALL` 拒绝、外部文件访问阻止、预取消与执行中取消、幂等关闭、重复打开、打开失败清理、L4 不匹配、字节预算，以及 Runtime + DuckDB + 精确向量搜索的端到端链路。未覆盖大表内存、真实 CDN 与浏览器路径。

### 未实现与未验证

- SQL 结果仍是完整数组，真正的流式返回未实现；
- 大表性能与内存未做实测，`maxTableBytes` 是拒绝阈值，不是内存保证；
- `PRAGMA` 配置类语句没有细粒度策略；
- 浏览器路径、真实 CDN、真实数据集查询均不在本包范围内。

## 与 CLI 的配合

发布前先用同一套 Parquet 做 L4 校验，再让 Runtime 打开包：

```bash
npx weisql inspect ./demo
npx weisql validate ./demo --l4
```

`inspect` 不打开 Runtime，只汇总表、向量、签名与未被声明的文件；`validate --l4` 会通过 `@weisql/duckdb-adapter` 读取 Parquet 并核对列名、类型与行数。没有安装适配器时返回 `[l4] SQL_UNSUPPORTED`，而不是崩溃。详见 [CLI](/docs/tooling/cli)。

## 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `SQL_UNSUPPORTED` | 写入、DDL、`CALL`、多语句或文件访问被禁 | 改用只读查询，检查是否误用了文件函数 |
| `INVALID_ARGUMENT` | 参数数量、语法、类型或 `maxRows` 非法 | 检查绑定值数量与类型；`maxRows` 必须是正安全整数 |
| `RESOURCE_INTEGRITY_FAILED` | L4 列名或类型与 Manifest 不一致 | 重新生成 Parquet 或修正 Manifest，再跑 `weisql validate --l4` |
| `QUERY_CANCELLED` | `AbortSignal` 已触发 | 区分超时取消与查询失败，不要重试已取消的请求 |
| `DATABASE_CLOSED` | 关闭后继续查询 | 在 `close()` 之前完成查询，或重新 `open()` |

## 延伸阅读

- [SQL 查询](/docs/sdk/sql)：`db.sql()` 的公开语义与 `maxRows`。
- [打开与生命周期](/docs/sdk/open-and-lifecycle)：`open()` 的注入点与关闭行为。
- [错误码](/docs/sdk/errors)：`SQL_UNSUPPORTED`、`INVALID_ARGUMENT` 等稳定错误码。
- [能力与兼容性](/docs/reference/compatibility)：Node 与浏览器的能力差异。
- [DuckDB Adapter 设计](https://github.com/fengjutian/WeiSQL/blob/main/docs/DUCKDB_ADAPTER.md)。
- [表加载模式](https://github.com/fengjutian/WeiSQL/blob/main/docs/TABLE_LOADING_OPTIONS.md)。
