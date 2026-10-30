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

## ADR-008：Manifest V1 候选字段形状评审

- 状态：Superseded by ADR-011
- 历史候选：曾提出 `format = weisql`、单文件表、`f32-le-row-major` 向量数据和显式 `index: null`；候选文件已在 ADR-011 冻结正式格式后移除。
- 与当前基线的冲突：当前实现使用 `format = weisql-ai`、表 `schema + files[]`、向量 `sourceTable + files[]`。
- 冻结前必须决定：稳定格式标识、表分片能力、引擎无关列类型、向量源表引用、空索引表示方式和空数据集语义。
- 约束：候选 Schema 不用于当前 Runtime，也不表示迁移已经完成；决定后必须原子更新 Schema、类型、校验器、样例和兼容性测试。

## ADR-011：冻结 Manifest V1 基础结构

- 状态：Accepted and implemented for L1/L2 validation
- 决策：格式标识为 `weisql`，版本固定 `1.0.0`；采用 `tables[].file` 与 `vectorCollections[]`，向量使用 `f32-le-row-major`，ID Map 使用 JSONL 加 `uint64-le` 偏移文件。
- 空集合：向量 `count = 0` 合法，对应向量和偏移文件声明字节数为 0。
- 路径：拒绝所有百分号编码，资源路径在包内全局唯一。
- 兼容性：此前 `weisql-ai`、`tables[].files`、`vectors[]` 结构不属于冻结 V1。
- 实现：正式 Schema、TypeScript 类型、运行时校验器、样例和测试已原子迁移；L3/L4 校验与 Builder 待实现。

## ADR-012：Builder 使用暂存构建与原子发布

- 状态：Accepted as implementation requirement
- 决策：Builder 只在私有临时目录生成资源，完成 Manifest L1/L2 和资源 L3 复验后，才将完整目录原子发布为不可变版本。
- 原因：防止失败构建、逐文件覆盖或并发读取暴露半成品数据包。
- 约束：默认拒绝覆盖；暂存区与目标优先位于同一文件系统；输出路径必须执行真实路径 containment 并拒绝包外符号链接。
- 规范：`MANIFEST_VALIDATOR_BUILDER_SPEC.md`。

## ADR-009：向量源表与业务 ID 映射

- 状态：Accepted for V1，待实现迁移
- 决策：向量声明增加 `tableName`；独立 `idMap` 文件按行映射业务 ID，编码为每行一个 `{row,id}` 对象的 JSONL。
- 原因：纯 Float32 文件不包含业务 ID，仅靠隐含行号无法可靠映射 SQL 记录；`tableName` 消除多表数据包中的 `idColumn` 歧义。
- 约束：行号连续且与向量顺序一致，计数相等，业务 ID 默认唯一；Builder 验证 ID 在目标表中存在。百万级替代编码需由实测驱动。
- 随机访问：V1 使用独立 `u64-le` 起始偏移文件；Runtime 批量读取偏移和连续 JSONL 区间。当前 Reader 已实现，Builder 生成器待完成。

## ADR-010：统一资源读取抽象

- 状态：Accepted for V1，具体 Reader 待实现
- 决策：Runtime 和 Adapter 通过 `ResourceReader` 访问资源，范围读取使用左闭右开 `[start,end)`；浏览器 HTTP、Node 文件和未来 `.wsql` 容器分别实现该接口。
- 原因：避免 Adapter 直接依赖 URL 或文件系统，集中处理路径、Range、取消、资源限制和流式完整性校验。
- 规范：`RESOURCE_READER_CONTRACT.md`。
- 实现门槛：至少完成 Node 文件与 HTTP 两个实现的契约测试；HTTP 必须严格验证 `206`、`Content-Range` 和实际长度。
- 当前进度：`HttpResourceReader` 首版及注入 Fetch 的契约测试已完成；Node 文件实现与真实 CDN 验收待完成。

## 明确禁止的未经验证声明

- 不宣称 100 万向量一定在毫秒级完成查询。
- 不宣称浏览器与 Node 具有完全一致的 SQL 功能。
- 不宣称单个 `.wsql` 文件一定能在 CDN 上高效随机读取。
- 不宣称 USearch 的所有目标平台都已支持，必须以实际构建和测试结果为准。
