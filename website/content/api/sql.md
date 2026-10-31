---
title: SQL API
description: db.sql() 与 db.sqlStream() 的签名、SQLValue 与 QueryOptions、maxRows 的两种执行方式，以及 SqlAdapter 契约与 Node/浏览器差异。
sidebar_position: 74
---

本页是 SQL 入口与 Adapter 契约的参考。SDK 只定义接口，不绑定引擎；`db.sql()` 的行为最终由注入的 `SqlAdapter` 决定。

## 签名

```ts
sql<T extends Record<string, unknown> = Record<string, unknown>>(
  query: string,
  params?: readonly SQLValue[],
  options?: QueryOptions,
): Promise<readonly T[]>;

sqlStream<T extends Record<string, unknown> = Record<string, unknown>>(
  query: string,
  params?: readonly SQLValue[],
  options?: QueryOptions,
): Promise<AsyncIterable<T>>;
```

| 参数 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `query` | `string` | 无 | 单条只读语句；空串或纯空白由 Adapter 拒绝 |
| `params` | `readonly SQLValue[]` | `[]` | 只通过占位符绑定，SDK 不做字符串插值 |
| `options.signal` | `AbortSignal` | 无 | 取消查询 |
| `options.maxRows` | `number` | 无 | 行数预算，不是分页 |

`sql()` 在调用 Adapter 前检查 Runtime 状态与 `signal`：未 `READY` 抛 `DATABASE_CLOSED`，已中止抛 `QUERY_CANCELLED`，未注入 Adapter 抛 `SQL_UNSUPPORTED`。`sqlStream()` 做同样的检查。

`sqlStream()` 返回异步可迭代对象；对未实现 `stream()` 的 Adapter，Runtime 回退为 `query()` 后逐行 yield 已物化的数组。结果正确，但不节省内存，也不是惰性读取。

```ts
const stream = await db.sqlStream<{ id: string }>(
  "select id from documents order by id",
  [],
  { maxRows: 1000 },
);

for await (const row of stream) {
  console.log(row.id);
}
```

## SQLValue

`SQLValue = string | number | bigint | boolean | null | Uint8Array | Date`。

| 值 | Node Adapter | 浏览器 Adapter |
| --- | --- | --- |
| `string` / `number` / `boolean` | 直接绑定 | 直接绑定 |
| `null` | 绑定 `NULL` | 绑定 `NULL` |
| `bigint` | 直接绑定 | 安全整数范围内转为 `number`，越界报错 |
| `Date` | 转为 `TIMESTAMP` | 拒绝（JSON 序列化无法保真） |
| `Uint8Array` | 转为 `BLOB` | 拒绝 |

不受支持的值不会被静默强制转换，两个 Adapter 都返回 `INVALID_ARGUMENT`（`details.parameter` 为参数下标）。参数个数必须等于语句的占位符个数，否则 `INVALID_ARGUMENT`（`details.expected` / `details.actual`）。

## QueryOptions 与 maxRows

`maxRows` 是“最多返回多少行”的硬上限：超过时抛错，绝不静默截断。它不能用于分页，也不能与 `LIMIT` 互相替代。

```ts
try {
  await db.sql("select * from documents", [], { maxRows: 10 });
} catch (error) {
  // error.code === "INVALID_ARGUMENT"; error.details.maxRows === 10
}
```

`maxRows` 必须是正安全整数，否则 Adapter 在准备语句前就返回 `INVALID_ARGUMENT`。SDK 本身不校验该字段，校验发生在 Adapter 内。

执行方式分两种，取决于语句形状：

1. **引擎改写（提前停止）**：可包装的语句被改写成 `SELECT * FROM (<原语句>) AS "weisql_row_limit" LIMIT maxRows + 1`，引擎最多多产出一行，随后由 Adapter 判定超限。Node 只对 `SELECT` 改写，浏览器对 `SELECT`、`VALUES`、`TABLE` 改写。
2. **返回后检查**：不能包装的元数据语句（如 `DESCRIBE`、`SHOW`、`EXPLAIN`）正常执行，行数超过预算时再报错。

流式路径在迭代过程中逐行计数，第 `maxRows + 1` 行到达时抛 `INVALID_ARGUMENT`，已经 `yield` 的行仍然有效。

## SqlAdapter 契约

```ts
interface SqlAdapterCapabilities {
  engine: string;
  engineVersion?: string;
  parameterBinding: boolean;
  parquet: boolean;
  supportedFeatures: readonly string[];
  cancellation: "native" | "best-effort" | "unsupported";
}

interface SqlAdapterOpenContext {
  manifest: Readonly<WeiSQLManifest>;
  reader: ResourceReader;
  signal?: AbortSignal;
}

interface SqlAdapter {
  readonly capabilities: Readonly<SqlAdapterCapabilities>;
  open(context: SqlAdapterOpenContext): Promise<void>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    parameters?: readonly SQLValue[],
    options?: QueryOptions,
  ): Promise<readonly T[]>;
  stream?<T extends Record<string, unknown> = Record<string, unknown>>(
    statement: string,
    parameters?: readonly SQLValue[],
    options?: QueryOptions,
  ): Promise<AsyncIterable<T>>;
  close(): Promise<void>;
}
```

| 成员 | 约定 |
| --- | --- |
| `open()` | Runtime 在 `open()` 阶段调用一次，传入 Manifest、`ResourceReader` 与可选 `signal`；两个官方 Adapter 都只允许调用一次 |
| `query()` | 必须自行执行只读边界、参数绑定与 `maxRows` 判定 |
| `stream?()` | 可选；缺失时 Runtime 回退到 `query()`，语义正确但结果已物化 |
| `close()` | Runtime 关闭时调用；`open()` 失败也会触发清理 |
| `capabilities` | 调用方据此判断取消语义与功能集，不要假定两个引擎等价 |

`SqlAdapterCapabilities.parameterBinding` / `parquet` 为 `false` 时，SDK 不会替你降级；是否可用由调用方判断。`cancellation` 为 `"best-effort"` 时必须预期“调用方已返回、引擎仍在跑”。

## Node 与 DuckDB-Wasm 的差异

| 维度 | Node（`@weisql/duckdb-adapter`） | 浏览器（`@weisql/duckdb-wasm-adapter`） |
| --- | --- | --- |
| `engine` | `"duckdb"`，带 `engineVersion` | `"duckdb-wasm"`，带 `engineVersion` |
| 只读边界 | 预处理语句的 `StatementType`，只放行 `SELECT` / `EXPLAIN` | 首关键字白名单；`WITH` 需 tokenizer 判定 CTE 后的真实动词 |
| 单语句 | `prepare()` 拒绝多语句 | 守卫拒绝第二条语句 |
| `maxRows` 改写 | 仅 `SELECT` | `SELECT` / `VALUES` / `TABLE` |
| 元数据语句 | 通过分类的语句在返回后检查 | `DESCRIBE` / `SHOW` / `EXPLAIN` 等在返回后检查 |
| 参数 | 字符串、数字、`bigint`、布尔、`null`、`Date`、`Uint8Array` | 字符串、数字、布尔、`null`、安全范围内 `bigint` |
| 取消 | `cancellation: "native"`，`connection.interrupt()` | `cancellation: "best-effort"`，`details.engineMayStillRun: true` |
| 表加载 | `tableLoading: "memory"`（默认）或 `"lazy"` | 始终物化为内存表 |
| 外部文件访问 | `memory` 关闭；`lazy` 保持开启 | `open()` 末尾关闭并锁定配置 |
| parquet 扩展 | 驱动内置 `read_parquet` | 需 `INSTALL` / `LOAD`，可配 `extensionRepository` |
| 单表预算 | `maxTableBytes`，默认 256 MiB | 默认 64 MiB |
| 整包预算 | `maxTotalTableBytes`，默认 512 MiB | 默认 128 MiB |
| 流式实现 | `execution.stream()` | `prepared.send()` 的 Arrow record batch |
| 特性标记 | `read-only-enforced`、`cte` 等 | `read-only-keyword-enforced`、`external-access-disabled`，tokenizer 可用时含 `cte` |

两端的 `verifyTableSchema` 都默认 `true`，L4 校验在表载入后比对 Manifest 的列名与类型，不一致返回 `RESOURCE_INTEGRITY_FAILED`。

## 只读边界

- V1 只有 `readonly` 模式，`open({ mode })` 传其他值返回 `INVALID_ARGUMENT`。
- Node 依赖引擎语句分类而不是关键字过滤，`WITH ... DELETE` 同样被拒绝；浏览器白名单放行 `SELECT`、`EXPLAIN`、`DESCRIBE`、`SHOW`、`SUMMARIZE`、`PIVOT`、`UNPIVOT`、`TABLE`、`VALUES`，tokenizer 不可用时 `WITH` 一律拒绝。
- 写语句、DDL、`COPY`、`ATTACH`、`SET`、`CALL`、`INSTALL` 等返回 `SQL_UNSUPPORTED`；多语句也返回 `SQL_UNSUPPORTED`。
- `open()` 的最后一步关闭外部文件访问并锁定配置，因此用户 SQL 里的 `read_parquet('/etc/passwd')` 会被拒绝。Node 的 `lazy` 模式是例外：它必须保留外部访问，只适用于 SQL 由应用作者编写的场景。
- 表物化受声明字节预算约束：超限返回 `RESOURCE_INTEGRITY_FAILED`，且整包检查先于引擎实例创建。

## 结果映射

- 返回 `readonly T[]`，每行是以列名为键的普通对象；重复列名以最后一列为准，别名请显式书写。
- `BLOB` 统一为 `Uint8Array`（Node 驱动返回的 `Buffer` 会被转换）；`BIGINT` 为 `bigint`；`TIMESTAMP` 为 `Date`；`NULL` 为 `null`（`undefined` 也归一为 `null`）。
- `DECIMAL` 被转换为 `number`，超过 15 位有效数字会丢精度；浏览器端通过 `castDecimalToDouble` 对齐这一行为。
- 嵌套 list / struct 会递归归一，深度上限 8 层。

## 完整 Node 示例

```ts
import { readFile } from "node:fs/promises";
import { open, NodeFileResourceReader } from "@weisql/sdk";
import { createDuckDbAdapter } from "@weisql/duckdb-adapter";

const root = "./datasets/demo";
const manifest = JSON.parse(await readFile(`${root}/manifest.json`, "utf8"));

const db = await open({
  manifest,
  resourceReader: new NodeFileResourceReader({ rootDirectory: root }),
  sqlAdapter: createDuckDbAdapter({ maxTableBytes: 64 * 1024 * 1024 }),
});

try {
  const rows = await db.sql<{ id: string; title: string }>(
    "select id, title from documents where category = ? order by id",
    ["genetics"],
    { maxRows: 1000 },
  );
  console.log(rows.length, rows[0]?.title);

  const stream = await db.sqlStream<{ id: string; title: string }>(
    "select id, title from documents order by id",
    [],
    { maxRows: 100000 },
  );
  let count = 0;
  for await (const row of stream) {
    count += 1;
    if (count === 1) console.log(row.id);
  }
} finally {
  await db.close();
}
```

`open()` 也接受 `manifestUrl`，但必须与 `manifest` 二选一；`NodeFileResourceReader` 以 `rootDirectory` 做真实路径 containment。

## 浏览器示例

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

const rows = await db.sql<{ total: number }>("select count(*) as total from documents");
```

浏览器端必须同源托管 parquet 扩展；未配置或加载失败时 `open()` 返回 `SQL_UNSUPPORTED`，不会静默降级。`Date` 参数在浏览器端不可用，请改传 ISO 字符串。

## 错误码

| 错误码 | 触发场景 |
| --- | --- |
| `SQL_UNSUPPORTED` | 未注入 Adapter；写语句或 DDL；多语句；浏览器缺 parquet 扩展；`WITH` 在无 tokenizer 时 |
| `INVALID_ARGUMENT` | 空语句；参数个数不匹配；`maxRows` 非法或超预算；不支持的参数类型；Adapter 选项非法 |
| `QUERY_CANCELLED` | `signal` 已中止；引擎侧 interrupt |
| `DATABASE_CLOSED` | Runtime 或 Adapter 不在 `READY` 状态 |
| `RESOURCE_INTEGRITY_FAILED` | 表字节超预算；表长度与 Manifest 不一致；L4 列名或类型不匹配 |
| `RESOURCE_NOT_FOUND` | 表资源缺失或不可读 |
| `INTERNAL_ERROR` | 引擎错误未被更具体的分支覆盖；资源释放失败 |

## 延伸阅读

- [SQL 查询指南](/docs/sdk/sql)：调用方式、Adapter 选项与常见排查。
- [DuckDB Adapter](/docs/adapters/duckdb)：Node 端的表加载模式、预算与已知限制。
- [DuckDB-Wasm Adapter](/docs/adapters/duckdb-wasm)：浏览器端的扩展托管、取消语义与内存预算。
- [兼容性参考](/docs/reference/compatibility)：两端函数覆盖与环境要求。
