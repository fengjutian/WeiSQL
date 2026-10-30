# 表加载模式：内存物化 vs 惰性视图

- 需求：V0.9 REQ-103「大型数据集不应默认整体读入内存」
- 结论：默认保持内存物化，另提供显式 `tableLoading: "lazy"`；两者不能同时满足安全与内存

## 1. 问题

DuckDB 要在 SQL 里被查询，表必须以某种形式进入它的目录。数据包本身是 Parquet 文件，通过 `ResourceReader` 读取，可能来自 HTTP Range 或本地文件。DuckDB 只能读取**它自己能访问的文件**，因此有三种接线方式：

1. 把整个文件读进内存，再 `CREATE TABLE ... AS SELECT` 物化；
2. 把文件写到临时目录，建**视图** `read_parquet('...')`，查询时按 row group 惰性读取；
3. 通过虚拟文件系统把 `ResourceReader` 的字节直接暴露给引擎，避免落地临时文件。

## 2. 选项对比

### 选项 A：虚拟文件系统（最小内存，最理想）

- 内存占用最低：引擎按需向 `ResourceReader` 要字节，不做整文件缓存。
- 旧读数可与 HTTP Range 直接对齐，天然支持远程包。
- **当前不可行**：`@duckdb/node-api` 2.0 没有暴露注册自定义文件系统的入口（`node-bindings` 只暴露 `register_scalar_function` 等）。DuckDB C API 有 `duckdb_register_file_system`，但未绑定到 Node。
- 结论：等上游绑定支持后再评估，不作为 V1 方案。

### 选项 B：视图 + 关闭外部访问（期望中的安全方案）

- 内存占用低，安全边界强。
- **实测不可行**：`SET enable_external_access=false` 之后视图立即失效，返回 `Permission Error: Cannot access file`。视图在每次查询时都要重新读文件，与关闭外部访问互斥。
- 结论：排除。

### 选项 C：视图 + 保留外部访问（本次新增 `lazy`）

- 内存占用低：DuckDB 只读取需要的 row group。
- **代价明确**：外部访问必须保持开启，于是用户 SQL 里的 `read_parquet('C:/Windows/win.ini')`、`read_csv_auto(...)` 会成功——这是本机任意文件读取。只读语句分类仍然有效（写入与 DDL 依旧被拒），但它挡不住读取。
- 适用前提：SQL 由应用作者编写，不接受终端用户输入。
- 结论：作为**显式可选项**保留，默认关闭。

### 选项 D：内存物化 + 关闭外部访问（默认）

- 安全边界最强：`enable_external_access=false` 生效后，任何文件函数失效；写入、DDL、配置修改由语句分类拒绝。
- **代价明确**：内存占用约等于表数据量；`maxTableBytes` 默认 256 MiB 在读取前拦截。
- 结论：保持默认。

## 3. 决策

| 模式 | 内存 | 外部文件访问 | 适用场景 |
| --- | --- | --- | --- |
| `memory`（默认） | 约等于表大小 | 关闭 | 任何 SQL，包括不可信输入 |
| `lazy` | 受 row group 控制 | **开启** | SQL 由应用作者编写 |

能力声明会如实反映选择：`memory` 模式输出 `external-access-disabled`，`lazy` 模式输出 `external-file-access-enabled`。调用方可以据此拒绝不匹配的安全策略。

## 4. 实现中发现的两个坑

1. **视图定义不能参数化**：`CREATE VIEW v AS SELECT * FROM read_parquet(?)` 被 DuckDB 拒绝（`Unexpected prepared parameter. This type of statement can't be prepared!`），而 `CREATE TABLE ... AS SELECT ... (?)` 可以。`lazy` 模式因此把路径作为转义字面量内联；路径来自 `mkdtemp()` 加 Manifest 已验证的标识符。
2. **错误码在视图上漂移**：`DELETE FROM <view>` 在 `prepare()` 阶段就失败（`can't delete from a view`），被归为 `INVALID_ARGUMENT`，而物化模式下同样语句会走到语句分类、返回 `SQL_UNSUPPORTED`。为保持两种模式一致，`query()` 增加了一层**前置关键字拒绝**（INSERT/UPDATE/DELETE/CREATE/... 直接返回 `SQL_UNSUPPORTED`）。它只用于稳定错误码，真正的边界仍是解析后的 `StatementType`。

## 5. 未做的事

- 没有测量两种模式的内存与延迟差异。REQ-404 需要先确定规模与硬件口径，否则数字不可比。
- 没有实现「按 row group 分片物化」或「列裁剪物化」等中间方案。
- `lazy` 模式没有提供 SQL 白名单来限制文件函数；如果将来需要，可以在 `prepare()` 之后分析引用表名，但那需要独立验证，不能用启发式规则冒充安全边界。
