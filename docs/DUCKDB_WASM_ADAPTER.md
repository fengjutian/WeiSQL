# DuckDB-Wasm Adapter

- 状态：Accepted and implemented（`@weisql/duckdb-wasm-adapter` 0.1.0，37 个测试 + 真实 Chromium 探针）
- 适用：浏览器端只读 SQL；Node.js 请用 `@weisql/duckdb-adapter`
- 契约：[SQL Adapter 契约](SQL_ADAPTER_CONTRACT.md)

## 1. 结论先说

浏览器端 SQL 已可用，但**不是**「装个包就完事」。三个事实决定了实现形状：

1. DuckDB-Wasm 的 `parquet` 扩展**不在** npm 包的 WASM 里，运行时才加载；
2. `extensions.duckdb.org` **不返回 CORS 头**，页面跨域 `XMLHttpRequest` 一定失败
   （ADR-020 当年观察到的「不可达」实际是这个现象，Node 端能下载是因为 Node 不执行 CORS）；
3. DuckDB-Wasm 的 JS API **不暴露** prepared statement 的 `StatementType`，
   Node 适配器那套「引擎级只读分类」在浏览器里拿不到。

因此本适配器的做法是：**扩展自托管 + 关键字白名单 + 关闭外部文件访问**，
并且把这三条限制写进文档和测试，而不是用「浏览器也支持 SQL」一句话盖过去。

## 2. 数据路径

```text
Manifest
  → Runtime（L1/L2，可选 L3 校验）
  → ResourceReader.read(table.file.path)        ← 与向量检索同一条读取路径
  → registerFileBuffer('weisql-<i>-<table>.parquet')
  → CREATE TABLE "<table>" AS SELECT * FROM read_parquet(?)
  → dropFile(...)                               ← 字节与表都已就位，立即释放 VFS 条目
  → SET enable_external_access=false
  → SET lock_configuration=true
```

要点：

- **DuckDB 不直接访问数据包 URL**。表数据来自 SDK Reader，Range、缓存、L3 摘要
  校验仍然只有一条路径；不会出现「SQL 绕过完整性校验」的缺口。
- **表在 `open()` 时物化**（`CREATE TABLE ... AS SELECT`），与 Node 适配器一致。
  峰值内存约为「Parquet 字节 + 表数据」，实测约为 Parquet 的 **4 倍**（§8.1），因此浏览器端有两层预算：

- `maxTableBytes`：单表上限，默认 **64 MiB**（Node 适配器是 256 MiB），一个表大致对应 256 MB 内存；
- `maxTotalTableBytes`：整个包的合计上限，默认 **128 MiB**，在加载 WASM 之前就检查——否则 10 张
  64 MiB 的表仍能申请 ~2.5 GB 内存。

两层都可在构造适配器时覆盖。
- 物化完成后立即 `dropFile`，VFS 里不长期保留 Parquet 副本。

## 3. 只读边界

| 层 | 做法 | 能挡住什么 |
| --- | --- | --- |
| 关键字白名单 | 只放行 `SELECT` / `EXPLAIN` / `DESCRIBE` / `SHOW` / `SUMMARIZE` / `PIVOT` / `UNPIVOT` / `TABLE` / `VALUES` | 写入、DDL、`SET`、`ATTACH`、`LOAD`、`INSTALL`、`COPY`、事务 |
| CTE 分类 | 用 DuckDB 自己的 tokenizer 跳过 CTE 列表，再判定真正的语句动词 | `with x as (...) delete from t` |
| 单语句扫描 | 识别字符串、标识符、注释与 dollar-quoted 文本后的 `;` | `select 1; delete from t` |
| 外部访问 | `enable_external_access=false` | 用户 SQL 里的 `read_parquet('/etc/passwd')` |
| 配置锁 | `lock_configuration=true` | 查询期再把外部访问打开 |

**CTE 支持取决于 tokenizer**。`WITH` 的首关键字不能说明语句类型：

- `AsyncDuckDB.tokenize()` 返回 `{ offsets, types }`，适配器据此跳过
  `[RECURSIVE] name [(cols)] [MATERIALIZED] AS ( ... ) {, ...}`，再看下一个关键字；
- 只有后面是 `SELECT` / `VALUES` / `TABLE` 等只读动词才放行，
  `WITH ... DELETE/INSERT/UPDATE` 一律 `SQL_UNSUPPORTED`；
- 结构无法识别（括号不闭合、缺 `AS`、CTE 后直接跟 `(` 等）**fail closed**；
- 注入的数据库没有 `tokenize`（或 tokenizer 抛错）时退回严格白名单，此时 `WITH` 仍被拒绝，
  且 `capabilities().supportedFeatures` 不含 `cte`；
- tokenizer 给的是 **UTF-8 字节偏移**，不是 JS 字符串下标；适配器先映射再切片，
  否则中文/emoji 字面量会把后面的关键字切错（`with x as (select '中') select 1` 有测试）。

`probe:wasm` 在真实 Chromium 里同时断言：带参数的只读 CTE 返回结果、写 CTE 被拒绝。

## 4. 参数绑定

绑定走 `AsyncPreparedStatement.query(...values)`，但 DuckDB-Wasm 会用
`JSON.stringify` 把参数送进 worker，因此：

| 参数 | 行为 |
| --- | --- |
| `string` / `number` / `boolean` / `null` | 支持 |
| 安全范围内的 `bigint` | 收窄为 `number` |
| 超出安全整数的 `bigint` | `INVALID_ARGUMENT`（不允许静默丢精度） |
| `Date` / `Uint8Array` / 对象 | `INVALID_ARGUMENT`，提示改传 ISO 字符串 |

参数值不会被拼进 SQL；`select ? is null`、`where id = ?` 都有测试覆盖。

### 结果映射

| 引擎类型 | 公开值 | 说明 |
| --- | --- | --- |
| `BIGINT` | `bigint` | `count(*)` 不降精度 |
| `DECIMAL` | `number` | 打开时 `castDecimalToDouble`，与 Node 驱动的行为一致；超过 15 位有效数字会丢精度 |
| `TIMESTAMP` | `Date` | Arrow 的 timestamp |
| `BLOB` | `Uint8Array` | 复制一份，不泄漏 Arrow 缓冲 |
| `INTEGER` / `DOUBLE` / `BOOLEAN` / `VARCHAR` / `NULL` | 原样 | |

DECIMAL 这一条不是可选项：不设置 `castDecimalToDouble` 时 Arrow 会把 `1.5` 交成
`Uint32Array`（unscaled words），既不是 `SQLValue`，也会让两端结果不一致。

**结果行数预算**：`maxRows` 与 Node 适配器语义相同——超限抛 `INVALID_ARGUMENT`
（`details.maxRows`），不截断。`SELECT` / `VALUES` / `TABLE` 会被包装成
`SELECT * FROM (<sql>) ... LIMIT maxRows + 1`，由 WASM 引擎提前停止；
`DESCRIBE` / `SHOW` / `SUMMARIZE` / `EXPLAIN` / `PIVOT` / `UNPIVOT` 无法安全包装，
在返回后检查。

**流式结果**：`db.sqlStream()` 用 `prepared.send()` 逐 Arrow batch 交付，不再把整表
放进一个数组；`maxRows` 逐行累计，超限抛 `INVALID_ARGUMENT`（调用方可能已收到前
`maxRows` 行）。取消语义与 `db.sql()` 相同：立即停止等待，单线程引擎可能继续跑完。
`break` 会关闭 prepared 语句。`probe:wasm` 断言了真实浏览器中的流式读取。

## 5. L4 与版本

- 默认开启 L4：对每张已物化的表执行 `DESCRIBE`，列名缺失或类型不匹配返回
  `RESOURCE_INTEGRITY_FAILED`。规则与 Node 适配器一致（`string/VARCHAR`、
  `json/JSON|VARCHAR` 等）。
- `capabilities().engineVersion` 来自 `select version()`，不是从包名推断。

## 6. 取消

`cancellation: "best-effort"`：

- 查询前已 abort → `QUERY_CANCELLED`，不会发给引擎；
- 查询中 abort → **调用方立即收到** `QUERY_CANCELLED`（`details.engineMayStillRun: true`），
  适配器不等待 worker；
- 同时会 fire-and-forget 调用 `connection.cancelSent()`，但它**不能抢占**单线程 worker 里
  正在执行的 CPU 密集查询。

实测（Chromium 1248，`select sum(sqrt(range)) from range(50000000)`）：完整执行 202 ms，
在第 50 ms abort，调用方 **51 ms** 就收到 `QUERY_CANCELLED`；同一时刻
`cancelSent()` 返回 `false`（请求排在查询后面）。因此这不是 `native`：引擎侧的工作
**没有**被终止，只是调用方不再等待。要真正抢占需要 pthreads/COI 多线程构建，尚未验证。

如果调用方在 abort 后立刻 `close()`，关闭会排在仍在执行的查询之后；适配器在取消路径上
不 `await` prepared statement 的关闭，避免把取消伪装成一次长等待。

## 7. 扩展自托管与部署

`npm run vendor:wasm-extension` 会把与 WASM 核心版本匹配的 `parquet` 扩展下载到
`.cache/duckdb-wasm-extensions/<version>/wasm_eh/`（已 git-ignore）。部署时：

```text
/extensions/v1.4.3/wasm_eh/parquet.duckdb_extension.wasm
```

并把 `extensionRepository` 设为 `https://<你的站点>/extensions`。
不设置时 DuckDB 会尝试 `extensions.duckdb.org`，在浏览器里会因 CORS 失败，
`open()` 返回 `SQL_UNSUPPORTED`（`phase: "extension"`），不会静默降级。

WASM 与 worker 文件同样需要自托管：

```html
<script type="importmap">
  { "imports": { "@duckdb/duckdb-wasm": "/vendor/duckdb/duckdb-browser.mjs" } }
</script>
```

真实打包器会处理 `apache-arrow` / `flatbuffers` / `tslib`；裸 ESM 演示需要 import map
（见 `tools/browser-probe/wasm.html`）。

## 8. 实测

环境：Chromium 1248（Playwright）、`@duckdb/duckdb-wasm` 1.32.0、DuckDB core `v1.4.3`、
fixture 3 行、扩展已缓存。

| 指标 | 数值 | 条件 |
| --- | --- | --- |
| `open()`（实例化 + 扩展 + 物化 + L4） | 1.37–1.70 s | 本地静态服务，扩展同源 |
| 参数化查询 | < 50 ms | 3 行表 |
| 浏览器 SQL 能力 | `capabilities().sql === true` | probe 断言 |
| 写入拒绝 | `SQL_UNSUPPORTED` | probe 断言 |
| 只读 CTE / 写 CTE | 前者返回结果、后者 `SQL_UNSUPPORTED` | probe 断言 |
| 过滤检索 | `exact-filter-first`，`exact: true`，2 条命中 | probe 断言（`db.vector.search` + `filter`） |
| Node ↔ Chromium SQL | 9 个查询 / 错误码全部一致 | `probe:parity` |
| 浏览器流式读取 | 1M 行 1,058 ms（约 945k 行/s），首行 14 ms | `bench:wasm-stream`，Chromium 1248，单次运行 |
| 查询中取消 | 202 ms 的查询在 50 ms abort 后 **51 ms** 返回 `QUERY_CANCELLED` | probe 断言；`cancelSent()` 返回 `false`，引擎未停 |
| parquet 扩展 | 498,915 B（`wasm_eh`，v1.4.3） | 自托管文件 |

这些数字只说明「能跑通、量级合理」，不构成性能承诺：数据只有 3 行，
首次加载还要拉 34 MB WASM。浏览器内的冷启动与真实大表未测量。

### 8.1 大表物化（`npm run bench:wasm`，Node 里的同一 WASM 构建）

合成数据（32 字符随机 id、随机 score，刻意低压缩），本机 Node 24、`--expose-gc`：

| 行数 | Parquet | `open()` | 过滤查询 | RSS 增量 |
| ---: | ---: | ---: | ---: | ---: |
| 50,000 | 1.9 MB | 160 ms | 5.9 ms | ~24 MB |
| 200,000 | 7.5 MB | 192 ms | 7.9 ms | ~43 MB |
| 500,000 | 18.8 MB | 298 ms | 12.9 ms | ~76 MB |

观察：物化耗时随行数线性增长（≈0.6 ms / 1000 行），RSS 增量约为 Parquet 的 **4 倍**
（Parquet 字节 + WASM 堆里的 VFS 副本 + 物化表）。这是**Node 里的 WASM 测量**，
浏览器还要加上 Worker/DOM 开销；不要把它当成浏览器内存承诺。

## 9. 测试

- 单元：`sql-guard`（白名单、注释、字符串里的分号、CTE 分类、UTF-8 偏移、fail-closed）、`values`（参数与行归一化）、`cancellation`（abort 竞速与引擎未停标记）、`error-contract`（扩展缺失与无 tokenizer 的退化路径）。
- 集成：用 `@duckdb/duckdb-wasm/blocking` 在 Node 里跑**同一个 WASM 引擎**，
  覆盖打开、参数绑定、注入、只读拒绝、只读/写/递归 CTE、中文 CTE、值映射、非法 SQL、预取消、多表、短读、外部访问、L4、默认预算、生命周期（18 个用例）。
  测试需要网络下载一次 parquet 扩展（缓存在 `~/.duckdb`）。
- 跨环境：`probe:parity` 把同一批 SQL 分别交给 Node DuckDB 与浏览器 DuckDB-Wasm，逐行比较并核对错误码。
- 浏览器：`npm run probe:wasm` 在真实 Chromium 中断言 `db.sql()` 结果、参数绑定、只读 CTE、过滤检索与写入拒绝；
  `npm run probe:playground` 还会在 Playground 里点「运行」并选类别过滤，断言两处结果一致。

## 10. 未验证 / 明确不做

- 浏览器内的大表与冷启动：§8.1 只测了 Node 里的同一 WASM 构建，未测 500k 行以上的浏览器内存；
  `maxTableBytes` 只是拒绝阈值，不是内存保证。
- **COI / 多线程**：试过，不可用。页面跨域隔离后 `duckdb-coi.wasm` 能跑（`threads=4`），但加载
  `parquet` 扩展直接 `LinkError`：扩展声明非共享内存，COI 运行时是共享内存；`wasm_threads`
  变体同样如此（v1.4.3）。见 ADR-063。
- OPFS 持久化与 `pthread` 路径。
- `date`/`timestamp`/二进制参数、结构化错误位置。
- 非 `SELECT` 的只读 CTE 形态（如 CTE 后直接跟括号子查询）按 fail-closed 拒绝，未逐一支持。
- CDN 上的扩展 CORS 配置（本实现要求同源自托管）。
- 与 Node 适配器的 SQL 方言一致性承诺：两端都叫 DuckDB，但能力边界不同，见 §3–§4。
