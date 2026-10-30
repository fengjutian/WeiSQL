# WeiSQL AI 技术决策记录

本文件区分已经确定的产品方向、待实验的工程选择和禁止提前承诺的事项。

## ADR-001：首版定位为静态只读嵌入式数据库

- 状态：Accepted
- 决策：V1 面向浏览器和 Node.js，数据随应用静态发布，不要求独立数据库服务；首版以只读查询为核心。
- 原因：降低部署和运维门槛，贴合静态网站/CDN 场景。
- 后果：不承诺多用户写入、事务同步或服务器端一致性。

## ADR-002：复用 SQL 引擎，不自研完整 SQL

- 状态：Accepted, subject to runtime validation
- 决策：优先评估 DuckDB；浏览器评估 DuckDB-Wasm，Node.js 使用官方支持的 Node 运行方式。
- 待验证：包体积、WASM 内存、Parquet 读取、参数绑定、浏览器与 Node 的 SQL 能力差异、许可和发布方式。

## ADR-003：向量引擎优先验证 USearch

- 状态：Provisional
- 决策：USearch 为首选候选；DuckDB VSS 作为对照；纯 Rust HNSW 为备选。
- 冻结条件：必须完成许可证审查、浏览器/WASM 与 Node 可用性验证、索引持久化往返测试、召回率与内存测试。
- 约束：不因库的存在就推断其所有运行时和格式都兼容。

## ADR-004：先实现精确搜索基线

- 状态：Accepted
- 决策：用简单、确定的暴力余弦搜索建立正确性基线，之后才能比较 ANN 的 Recall@K 和延迟。
- 原因：没有 ground truth 就无法可信评估 ANN 召回率。

## ADR-005：先多文件，后冻结 .wsql

- 状态：Accepted
- 决策：先实现 `manifest.json` + 数据分片 + 索引资源。`.wsql` 容器先写草案和原型，不在没有 Range/随机访问测试前冻结二进制协议。
- 原因：容器格式过早冻结会限制按需加载、压缩和索引格式演进。

## ADR-006：TypeScript SDK 为稳定入口，引擎通过 Adapter 接入

- 状态：Accepted
- 决策：应用只依赖 TypeScript SDK 的 `open`、`sql`、`vector.search`、`close` 和能力声明；DuckDB、USearch、Rust Core 及未来引擎通过 SQL/Vector Adapter 接入。
- 原因：避免 Manifest 和公共 API 依赖某个引擎的内部类型，使浏览器与 Node.js 可以采用不同实现而保持公共语义稳定。
- 约束：可替换是接口目标，不表示当前已经实现或验证多个引擎。Adapter 必须通过统一契约测试。
- 规范：`SQL_ADAPTER_CONTRACT.md`、`VECTOR_ADAPTER_CONTRACT.md`。

## ADR-007：向量原始数据使用专用 data 描述

- 状态：Proposed，待 Schema、校验器、样例和兼容性测试同步后接受
- 决策：Manifest 向量资源使用包含 `layout`、`count`、`bytes` 和 `sha256` 的 `data` 对象，不再用通用 `files[]` 表达 V1 原始连续 Float32 向量。
- 原因：向量数据需要显式声明布局，并可校验 `count × dimension × 4` 与字节数的一致性。
- 迁移影响：当前 JSON Schema、TypeScript 类型、校验器和样例仍使用 `vectors.files[]`，在迁移完成前不得把本决策描述为已实现。
- 规范：`MANIFEST_SPEC_V1.md`。

## 明确禁止的未经验证声明

- 不宣称 100 万向量一定在毫秒级完成查询。
- 不宣称浏览器与 Node 具有完全一致的 SQL 功能。
- 不宣称单个 `.wsql` 文件一定能在 CDN 上高效随机读取。
- 不宣称 USearch 的所有目标平台都已支持，必须以实际构建和测试结果为准。
