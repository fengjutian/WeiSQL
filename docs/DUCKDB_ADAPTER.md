# WeiSQL DuckDB Adapter（Node.js）

- 包：`@weisql/duckdb-adapter`
- 状态：V1 首版已实现，14 个自动化测试覆盖 `SQL_ADAPTER_CONTRACT.md` 的契约项
- 引擎：`@duckdb/node-api` 2.x（DuckDB 2.0，win32-x64/linux-x64/darwin 预编译绑定）
- 适用运行时：Node.js 20+（依赖原生绑定，不可用于浏览器）

SDK 不依赖本包；应用通过 `open({ sqlAdapter })` 注入，SDK 因此保持零引擎依赖。

## 1. 打开流程

```ts
import { open, NodeFileResourceReader } from "@weisql/sdk";
import { createDuckDbAdapter } from "@weisql/duckdb-adapter";

const db = await open({
  manifestUrl: "./demo/manifest.json",
  resourceReader: new NodeFileResourceReader({ rootDirectory: "./demo" }),
  sqlAdapter: createDuckDbAdapter({ maxTableBytes: 256 * 1024 * 1024 }),
  verifyChecksums: "all", // 可选：L3 校验先于引擎接触字节
});
```

`open()` 内部顺序：

1. 创建 `:memory:` 实例并建立连接；
2. 逐表从 `ResourceReader` 读取字节，校验长度等于 Manifest 声明值；
3. 写入临时目录后执行 `CREATE TABLE <name> AS SELECT * FROM read_parquet(?)`，随后立即删除临时文件；
4. 按 `DESCRIBE` 比对 Manifest 的列名与类型（L4）；
5. 设置 `enable_external_access=false` 与 `lock_configuration=true`；
6. 读取 `version()` 填充 `engineVersion`，状态转为 `READY`。

任一步失败都会关闭连接、释放实例、删除临时目录，状态转为 `FAILED`。

## 2. 为什么物化而不是建视图

`CREATE VIEW ... AS SELECT * FROM read_parquet('...')` 更节省内存，但视图在每次查询时都要重新访问文件。一旦为了安全关闭外部文件访问，视图立刻失效（实测：`Permission Error: Cannot access file`）；而如果保留外部访问，用户 SQL 里的 `read_parquet('/etc/passwd')`、`read_csv_auto(...)` 就会成为任意文件读取通道。

两条路只能选一条。V1 选择**安全边界优先**：

| 方案 | 内存 | 外部文件访问 |
| --- | --- | --- |
| 视图 + 保留外部访问 | 低 | **开放，不可接受** |
| 视图 + 关闭外部访问 | 低 | 视图不可用 |
| 物化表 + 关闭外部访问 | 等于表数据量 | 关闭 |

代价是内存占用与 `open()` 时的读取量。`maxTableBytes`（默认 256 MiB）在读取前拦截超大表。若未来需要低内存，可行方向是 DuckDB 的虚拟文件系统注册或分片表，两者都需要独立验证，目前未实现。

## 3. 只读边界

边界建立在引擎自己的语句分类上，而不是字符串匹配：

- `prepare(statement)` 返回的 `StatementType` 必须是 `SELECT` 或 `EXPLAIN`，否则 `SQL_UNSUPPORTED`。
- 由此 `INSERT/UPDATE/DELETE/COPY/CREATE/ALTER/DROP/SET/PRAGMA 写/Persistence` 全部被拒；`WITH ... DELETE` 这类伪装写法同样被拒，因为分类来自解析后的语句。
- `DESCRIBE`、`SHOW`、`SUMMARIZE`、`PRAGMA table_info(...)` 在 DuckDB 中分类为 `SELECT`，因此可用。
- `CALL` 属于独立类型，返回 `SQL_UNSUPPORTED`。
- `prepare()` 拒绝多语句输入（`Cannot prepare multiple statements at once!`），一次调用无法夹带第二条语句。
- `enable_external_access=false` 关闭文件与网络函数；`lock_configuration=true` 阻止后续再改配置。

上述每一条都有对应测试（`packages/duckdb-adapter/test/adapter.test.js`）。

## 4. 参数绑定与结果映射

参数一律通过预处理语句绑定，不接受 SQL 插值。`SQLValue` 到 DuckDB 的映射：

| `SQLValue` | 绑定方式 |
| --- | --- |
| `null` / `string` / `number` / `boolean` / `bigint` | 直接绑定 |
| `Date` | `timestampValue(millis × 1000)`，按 UTC 微秒解释 |
| `Uint8Array` | `blobValue(...)` |

结果映射：

| DuckDB 类型 | JavaScript |
| --- | --- |
| `BIGINT`、`HUGEINT` | `bigint`（不降级为 `number`） |
| `INTEGER`、`SMALLINT`、`FLOAT`、`DOUBLE`、`DECIMAL` | `number` |
| `TIMESTAMP*`、`DATE` | `Date`（时间戳按 UTC 实例解释，日期为 UTC 零点） |
| `BLOB` | `Uint8Array`（驱动返回的 `Buffer` 会被转换，避免 Node 类型泄漏） |
| `STRUCT`、`LIST`、`MAP` | 普通对象 / 数组，递归转换其中的 `Buffer` |
| `NULL` | `null` |

已知限制：

- `DECIMAL` 由驱动转成 `number`，超过 15 位有效数字会丢精度；
- `INTERVAL`、`UNION`、`BIT` 等未做专门映射，按驱动默认值透传，属于未验证能力；
- 可空性不参与 L4 比对：`read_parquet` 不保留 `NOT NULL` 约束，`DESCRIBE` 对声明非空列也返回 `YES`。

## 5. 取消与生命周期

- 取消是**原生**的：`AbortSignal` 触发 `connection.interrupt()`，执行中的查询以 `QUERY_CANCELLED` 结束（测试中约 50–100 ms 内返回），连接在中断后仍可继续使用。
- `close()` 幂等；关闭后 `query()` 返回 `DATABASE_CLOSED`。
- 重复 `open()` 返回 `INVALID_ARGUMENT`，不产生第二个实例。

## 6. 错误归一化

| 引擎信号 | 归一化错误码 |
| --- | --- |
| `INTERRUPT` | `QUERY_CANCELLED` |
| 多语句 | `SQL_UNSUPPORTED` |
| `Permission Error` / 文件访问被禁 | `SQL_UNSUPPORTED` |
| `Parser/Binder/Catalog/Conversion Error` | `INVALID_ARGUMENT` |
| 其他 | `INTERNAL_ERROR` |

错误详情包含阶段（`open` / `prepare` / `execute`）、引擎名和截断到 300 字符的引擎摘要；不附带完整 SQL 或参数值。

## 7. 测试覆盖

`packages/duckdb-adapter/test/adapter.test.js` 覆盖：能力声明、真实表查询、参数绑定与非插值、参数数量与语法错误、类型映射、写操作/DDL/配置/`CALL` 拒绝、外部文件访问阻止、取消（预取消与执行中）、幂等关闭、重复打开、打开失败清理（含临时目录检查）、L4 模式不匹配、字节长度与预算，以及 Runtime + DuckDB + 精确向量搜索的端到端链路。

未覆盖且不得声称已完成：DuckDB-Wasm 浏览器路径、真实 CDN 部署、大表性能与内存实测、`PRAGMA` 配置类语句的细粒度策略。
