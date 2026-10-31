---
title: SQL 查询
description: 用 db.sql() 与 db.sqlStream() 执行参数绑定的只读 SQL，选择 Node 或浏览器 DuckDB Adapter，理解只读边界与行数预算。
sidebar_position: 25
hero:
  kicker: "SDK · SQL"
  title: "只读 SQL，通过 Adapter 注入"
  lead: "参数绑定、语句级只读边界与流式读取；SDK 本身不绑定引擎。"
  chips: ["DuckDB", "DuckDB-Wasm", "maxRows", "sqlStream"]
hide_title: true
examples: [node, browser]
---


本页讲 `db.sql()` / `db.sqlStream()` 的调用契约与两个官方 SQL Adapter 的行为差异。读完后你能正确绑定参数、设置 `maxRows`，并判断当前环境支持哪些语句与参数类型。

## 最小示例

Node.js 端：

```ts
import { readFile } from "node:fs/promises";
import { open, NodeFileResourceReader } from "@weisql/sdk";
import { createDuckDbAdapter } from "@weisql/duckdb-adapter";

const manifest = JSON.parse(await readFile("./demo/manifest.json", "utf8"));

const db = await open({
  manifest,
  resourceReader: new NodeFileResourceReader({ rootDirectory: "./demo" }),
  sqlAdapter: createDuckDbAdapter(),
});

const rows = await db.sql(
  "select id, title from documents where category = ? order by id",
  ["genetics"],
);
```

浏览器端：

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
```

未注入 `sqlAdapter` 时 `sql()` 抛 `SQL_UNSUPPORTED`，SDK 不含任何内置引擎。

## db.sql() 参数

```ts
sql<T extends Record<string, unknown>>(
  query: string,
  params?: readonly SQLValue[],
  options?: QueryOptions,
): Promise<readonly T[]>;
```

| 参数/选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `query` | `string` | 无 | 单条 SQL 语句 |
| `params` | `readonly SQLValue[]` | `[]` | 只通过占位符绑定，不做字符串插值 |
| `options.signal` | `AbortSignal` | 无 | 取消查询 |
| `options.maxRows` | `number` | 无 | 行数预算，不是分页 |

`SQLValue` 为 `string | number | bigint | boolean | null | Uint8Array | Date`。是否接受某种值取决于 Adapter。

`maxRows` 是正安全整数；超过预算抛 `INVALID_ARGUMENT`（`details.maxRows`），不会静默截断。普通 `SELECT`/`VALUES`/`TABLE` 会被改写为带 `LIMIT maxRows + 1` 的子查询，让引擎提前停止；`DESCRIBE`、`SHOW`、`SUMMARIZE`、`EXPLAIN` 这类元数据语句在返回后检查。

返回行是普通对象数组，按契约不可变。

### 参数绑定与行数预算

```ts
const rows = await db.sql(
  "select id from documents where category = ? and score >= ?",
  ["genetics", 0.5],
  { maxRows: 100 },
);
```

不要把不可信值拼进 SQL 字符串；SDK 与两个 Adapter 都只接受占位符绑定。`maxRows` 触发时抛错而不是返回前 N 行：

```ts
try {
  await db.sql("select * from documents", [], { maxRows: 10 });
} catch (error) {
  // error.code === "INVALID_ARGUMENT"，details.maxRows === 10
}
```

## db.sqlStream()

需要边读边处理大结果集时，用 `sqlStream()` 拿一个异步可迭代对象：

```ts
const stream = await db.sqlStream(
  "select id, title from documents order by id",
  [],
  { maxRows: 1000 },
);

for await (const row of stream) {
  console.log(row.id, row.title);
  // 处理完当前行就可以继续；提前 break 会关闭底层结果并释放资源。
}
```

```ts
sqlStream<T extends Record<string, unknown>>(
  query: string,
  params?: readonly SQLValue[],
  options?: QueryOptions,
): Promise<AsyncIterable<T>>;
```

行为要点：

- 两个官方 Adapter 都实现了真正的分批读取：Node 用 `execution.stream()`，浏览器用 Arrow record batch；调用方不需要等全部结果物化。
- `maxRows` 在迭代过程中强制：第 `maxRows + 1` 行到达时抛 `INVALID_ARGUMENT`，已经 `yield` 的行仍然有效。
- 对没有实现 `stream()` 的自定义 Adapter，Runtime 会回退到 `query()` 并把已物化的数组逐行 yield；结果正确，但不节省内存。
- 取消语义跟随 Adapter：Node 的 `signal` 会 `interrupt()`；浏览器是 best-effort，停止等待但引擎可能继续跑。
- 生成器提前 `break`、抛错或正常结束都会关闭底层结果；不要在 `for await` 外长期持有迭代器。

`sql()` 仍适合小结果集或需要一次性拿到数组的场景；两者共享同一套只读边界与参数绑定。

## Node.js：createDuckDbAdapter

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `maxTableBytes` | `number` | 256 MiB | 单表声明字节上限，读取前拦截 |
| `maxTotalTableBytes` | `number` | 512 MiB | 整包表字节上限，创建实例前检查 |
| `verifyTableSchema` | `boolean` | `true` | 比对 Parquet 物理模式与 Manifest（L4） |
| `tableLoading` | `"memory" \| "lazy"` | `"memory"` | 物化进内存，或临时文件加视图 |
| `config` | `Record<string, string>` | 无 | 创建内存实例时附加的 DuckDB 配置 |

只读边界：

- 只执行 `SELECT` 与 `EXPLAIN` 预处理语句；`INSERT`、`UPDATE`、`DELETE`、`COPY`、`CREATE`、`ALTER`、`SET`、`CALL` 一律 `SQL_UNSUPPORTED`。
- 多语句输入在 `prepare()` 阶段被拒绝，一次调用无法夹带第二条语句。
- 只读靠引擎的语句分类，不靠关键字过滤；`WITH ... DELETE` 同样被拒绝。
- `memory` 模式先 `CREATE TABLE ... AS SELECT` 物化，再设置 `enable_external_access=false` 与 `lock_configuration=true`，因此用户 SQL 里的 `read_parquet('/etc/passwd')` 会失败。
- 物化的内存成本约等于表数据量，由两层声明字节预算兜底。
- `lazy` 模式保留视图与临时文件，内存受 row group 控制，但**外部文件访问必须保持开启**：只适用于 SQL 由应用作者编写、不接受终端用户输入的场景。

L4 校验在表载入后按 Manifest 的列名与类型比对 `DESCRIBE`，不一致返回 `RESOURCE_INTEGRITY_FAILED`；可用 `verifyTableSchema: false` 关闭。

取消是原生的：`capabilities.cancellation` 为 `"native"`，通过 `connection.interrupt()` 中断执行中的查询。

已知限制：`DECIMAL` 由驱动转为 `number`，超过 15 位有效数字会丢精度；可空性不在 L4 比对范围内。

## 浏览器：createDuckDbWasmAdapter

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `bundles` | `{ mainModule, mainWorker, pthreadWorker? }` | 无 | WASM 与 Worker 的 URL；与 `database` 二选一 |
| `database` | `WasmDuckDb` | 无 | 复用已有实例；此时 Adapter 不创建也不销毁它 |
| `maxTableBytes` | `number` | 64 MiB | 单表声明字节上限 |
| `maxTotalTableBytes` | `number` | 128 MiB | 整包上限，在读取表之前检查 |
| `verifyTableSchema` | `boolean` | `true` | L4 校验 |
| `extensionRepository` | `string` | 无 | 自托管 parquet 扩展的基 URL |
| `logger` | `"silent" \| "console"` | `"silent"` | 是否转发 DuckDB-Wasm 日志 |

行为差异：

- 表来自 SDK 的字节：`ResourceReader.read()` 取得 Parquet 后 `registerFileBuffer`，再 `CREATE TABLE ... AS SELECT`。DuckDB 不直接下载数据包，L3 校验不会被绕过。
- 只读用首关键字白名单：`SELECT`、`EXPLAIN`、`DESCRIBE`、`SHOW`、`SUMMARIZE`、`PIVOT`、`UNPIVOT`、`TABLE`、`VALUES`。`WITH` 交给 DuckDB 自己的 tokenizer 跳过 CTE 列表后判定真实动词，所以只读 CTE 可用、`WITH ... DELETE` 被拒绝；tokenizer 不可用时退回严格白名单，`WITH` 被拒绝。
- 参数受 JSON 序列化限制：只接受字符串、数字、布尔、`null` 与安全范围内的 `bigint`；`Date`、二进制与超范围整数返回 `INVALID_ARGUMENT`。
- `maxRows` 语义与 Node 一致：超限报错，不截断。
- 取消是 best-effort，不是 native：查询中 abort 会立刻返回 `QUERY_CANCELLED`，`details.engineMayStillRun` 为 `true`，但单线程 worker 里的查询不会被抢占。
- parquet 扩展必须同源托管；未配置或加载失败时 `open()` 返回 `SQL_UNSUPPORTED`，不会静默降级。
- 内存约为 Parquet 大小的 4 倍，因此默认预算比 Node 小。

## 能力声明

两个 Adapter 都通过 `capabilities` 暴露 `engine`、`parameterBinding`、`parquet`、`supportedFeatures` 与 `cancellation`。Node 的 `supportedFeatures` 含 `read-only-enforced`，浏览器含 `read-only-keyword-enforced` 与 `external-access-disabled`。调用方应据此拒绝不匹配的安全策略，而不是假定两端完全等价。

## 常见错误

| 错误码 | 场景 |
| --- | --- |
| `SQL_UNSUPPORTED` | 未注入 Adapter；写语句或 DDL；多语句；浏览器缺扩展；`lazy` 之外的外部访问受限语句 |
| `INVALID_ARGUMENT` | `maxRows` 非法或超预算；浏览器端不支持的参数类型；Adapter 选项非法 |
| `RESOURCE_INTEGRITY_FAILED` | L4 列名或类型不一致；表字节超过预算 |
| `QUERY_CANCELLED` | 查询被取消 |
| `DATABASE_CLOSED` | 数据库已关闭 |
| `RESOURCE_NOT_FOUND` | 表资源缺失 |

## 行为边界

- SDK 只定义 `SqlAdapter` 契约，不绑定引擎；两个 Adapter 的 SQL 函数覆盖不完全等价。
- `sql()` 一次性返回数组；需要边读边处理时用 `sqlStream()`。`maxRows` 只能拒绝超限，不能分页。
- 浏览器端不支持 `Date` 与二进制参数；OPFS 持久化未实现。
- 真实 CDN 上的 WASM 首载、CORS 与多机冷缓存未验证；性能数字不能从 Node 外推到 WASM。
- `lazy` 模式没有文件函数白名单，安全前提是 SQL 由应用作者编写。

## 延伸阅读

- [SQL Adapter 契约](https://github.com/fengjutian/WeiSQL/blob/main/docs/SQL_ADAPTER_CONTRACT.md)
- [表加载模式对比](https://github.com/fengjutian/WeiSQL/blob/main/docs/TABLE_LOADING_OPTIONS.md)
- [DuckDB-Wasm Adapter](https://github.com/fengjutian/WeiSQL/blob/main/docs/DUCKDB_WASM_ADAPTER.md)
