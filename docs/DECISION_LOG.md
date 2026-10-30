# WeiSQL AI 技术决策记录

本文件区分已经确定的产品方向、待实验的工程选择和禁止提前承诺的事项。

## ADR-001：首版定位为静态只读嵌入式数据库

- 状态：Accepted
- 决策：V1 面向浏览器和 Node.js，数据随应用静态发布，不要求独立数据库服务；首版以只读查询为核心。
- 原因：降低部署和运维门槛，贴合静态网站/CDN 场景。
- 后果：不承诺多用户写入、事务同步或服务器端一致性。

## ADR-002：复用 SQL 引擎，不自研完整 SQL

- 状态：Accepted and validated on Node.js（`@weisql/duckdb-adapter`：DuckDB 2.0 + `@duckdb/node-api`）；DuckDB-Wasm 仍未验证
- 决策：优先评估 DuckDB；浏览器评估 DuckDB-Wasm，Node.js 使用官方支持的 Node 运行方式。
- 已验证（Node.js）：Parquet 读取、参数绑定、语句级只读、原生中断、结果类型映射、许可（MIT）。
- 待验证：包体积、WASM 内存、浏览器与 Node 的 SQL 能力差异、DuckDB-Wasm 发布方式。

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

## ADR-013：不可变发布版本与入口指针

- 状态：Accepted as deployment requirement
- 决策：每次构建发布到新的不可变版本目录；本地或静态托管完成全部资源上传与验证后，最后切换 `current.json` 或等价入口。
- 原因：防止新 Manifest 与旧资源混用，并支持缓存隔离和快速回滚。
- 约束：Runtime 会话固定使用解析时的发布版本；缓存键包含发布身份和资源验证身份；不得原地修改已发布版本目录。

## ADR-014：V1 使用单一稳定错误码体系

- 状态：Accepted
- 决策：Builder、Runtime、ResourceReader 和 Adapter 共用 `WeiSQLErrorCode`；同义草案错误码不进入公共 API。
- 统一映射：文件大小、摘要和内容损坏归入 `RESOURCE_INTEGRITY_FAILED`；取消归入 `QUERY_CANCELLED`；不安全路径归入 `PATH_INVALID`。
- 原因：避免不同包和运行时要求调用方处理多套同义错误。
- 规范：`PUBLIC_TYPES_AND_ERRORS_V1.md`。

## ADR-009：向量源表与业务 ID 映射

- 状态：Accepted for V1；`IndexedIdMapReader` 已实现，Builder 生成器待完成
- 决策：向量声明增加 `tableName`；独立 `idMap` 文件按行映射业务 ID，编码为每行一个 `{row,id}` 对象的 JSONL。
- 原因：纯 Float32 文件不包含业务 ID，仅靠隐含行号无法可靠映射 SQL 记录；`tableName` 消除多表数据包中的 `idColumn` 歧义。
- 约束：行号连续且与向量顺序一致，计数相等，业务 ID 默认唯一；Builder 验证 ID 在目标表中存在。百万级替代编码需由实测驱动。
- 随机访问：V1 使用独立 `u64-le` 起始偏移文件；Runtime 批量读取偏移和连续 JSONL 区间。当前 Reader 已实现，Builder 生成器待完成。

## ADR-010：统一资源读取抽象

- 状态：Accepted for V1，HTTP 与 Node 文件实现已完成首版
- 决策：Runtime 和 Adapter 通过 `ResourceReader` 访问资源，范围读取使用左闭右开 `[start,end)`；浏览器 HTTP、Node 文件和未来 `.wsql` 容器分别实现该接口。
- 原因：避免 Adapter 直接依赖 URL 或文件系统，集中处理路径、Range、取消、资源限制和流式完整性校验。
- 规范：`RESOURCE_READER_CONTRACT.md`。
- 实现门槛：至少完成 Node 文件与 HTTP 两个实现的契约测试；HTTP 必须严格验证 `206`、`Content-Range` 和实际长度。
- 当前进度：`HttpResourceReader` 与 `NodeFileResourceReader` 首版及自动化测试已完成；流式 SHA-256 完整性层、LRU 缓存和真实 CDN 验收待完成。

## ADR-015：评估带哨兵的 ID Map 边界偏移

- 状态：Proposed，不适用于 Manifest `1.0.0`
- 当前 V1：偏移文件保存 `count` 个记录起始位置，大小为 `count × 8`；最后一条记录以 `idMap.data.bytes` 作为结束位置，空集合偏移文件为零字节。
- 提案：未来格式保存 `count + 1` 个边界值，大小为 `(count + 1) × 8`；第一项为 0，最后一项等于 JSONL 字节数，空集合保存一个 0。
- 收益：每条记录的 Range 可直接计算，尾边界也能在偏移文件内部验证。
- 兼容性：两种字节布局无法可靠自动区分，属于数据格式破坏性变更，不能在 V1 中静默替换。
- 接受条件：启用新的格式版本，并原子更新 Schema、类型、Builder、Reader、fixtures、迁移说明和跨运行时测试。接受前不得生成或宣称支持哨兵布局。

## ADR-016：Builder 只消费已有 Parquet，L3 分成三种可验证等级

- 状态：Accepted and implemented（V1 首版）
- 决策一：Builder 输入是已存在的 Parquet 文件、原始向量与业务 ID；不在 TypeScript 内生成 Parquet，也不做 CSV/JSON 类型推断。理由：Parquet 编码器（Thrift compact metadata、页编码、定义/重复层级）出错成本高且难以自证，而 V1 的真正缺口是摘要、ID Map 与 L3 校验，不是文件编码。
- 决策二：`verifyChecksums` 分为 `none` / `manifest` / `all`，与 `RESOURCE_INTEGRITY_SPEC.md` 一致。`manifest` 只比较 `stat` 长度，不读取完整内容；`all` 才做增量 SHA-256 与 ID Map 内容校验。报告用 `sizeVerified` 与 `hashesVerified` 区分，不得把长度校验描述成内容校验。
- 决策三：SHA-256 自行实现为增量 `Sha256` 类，不依赖 `node:crypto` 或 WebCrypto。理由：浏览器 WebCrypto 无流式 API，加载 `node:crypto` 会破坏浏览器主包；纯函数实现可用 `node:crypto` 对照测试证明正确性。
- 决策四：Builder 在暂存目录完成写入、重新读取、L1/L2/L3 复验后才原子重命名发布；`overwrite` 先把旧目录改名保留，成功后才删除，失败则回滚。未提供 `rowIds` 时主键交叉校验只产生 `id-membership-unverified` 警告，不伪造通过。
- 后果：`data/*.parquet` 的内容正确性仍属 L4，需 SQL 引擎或独立 Parquet reader 验证；当前测试用 `hyparquet`（devDependency）读取三条记录作为独立证据。

## ADR-017：DuckDB Adapter 用语句分类做只读边界，并接受内存物化

- 状态：Accepted and implemented（Node.js 首版）
- 决策一：Adapter 作为独立包 `@weisql/duckdb-adapter`，通过 `open({ sqlAdapter })` 注入。SDK 保持零引擎依赖，浏览器构建不会被 Node 原生绑定污染。
- 决策二：只读边界建立在 DuckDB 解析后的 `StatementType` 上——只执行 `SELECT` 与 `EXPLAIN`。原因：关键字过滤可被 `WITH ... DELETE`、注释与大小写变体绕过，而语句分类来自同一个解析器，无法伪装。同时 `prepare()` 天然拒绝多语句输入。
- 决策三：表在 `open()` 时以 `CREATE TABLE ... AS SELECT * FROM read_parquet(?)` 物化进 `:memory:`，而不是建视图。实测：视图在 `enable_external_access=false` 后立即因 `Permission Error` 失效；若保留外部访问，用户 SQL 的 `read_parquet('/etc/passwd')` 就是任意文件读取通道。两个目标不可兼得，V1 选择安全边界。
- 决策四：代价显式化。内存成本约等于表数据量，由 `maxTableBytes`（默认 256 MiB）在读取前拦截；这是已记录的限制，不是遗漏。
- 决策五：用 `DESCRIBE` 做 L4 模式校验（列名 + 物理类型），不比对可空性，因为 `read_parquet` 不保留 `NOT NULL` 约束。
- 决策六：取消使用 `connection.interrupt()`，因此能力声明为 `native` 而非 `best-effort`；测试验证中断后可继续使用同一连接。
- 后果：`DECIMAL` 由驱动转 `number`（>15 位有效数字丢精度），`INTERVAL`/`UNION`/`BIT` 未专门映射——均为已记录限制。大表内存与大包体积尚未实测，不得对外声明性能结论。

## ADR-018：混合检索先过滤后精确扫描，并接受 O(N) 反向索引

- 状态：Accepted and implemented（`exact-filter-first`）；`vector-first` 未实现
- 决策一：`filter` 在 Top-K **之前**生效。先用 SQL 求出满足条件的完整业务 ID 集合，映射为向量行，再让精确扫描只考虑这些行。反向做法（先取 Top-K 再丢弃不匹配项）在过滤子集较小时会少返回结果，也无法诚实地声明 `exact: true`，因此不采用。
- 决策二：Hybrid 逻辑放在独立 `hybrid-executor.ts`，Runtime 只负责注入依赖与诊断，遵守 V0.8 §4「不进入 Runtime 主类硬编码」。`vector-first` 与自适应策略留待需要成本模型时再引入独立执行器。
- 决策三：过滤器只接受 Manifest 白名单中的列，值按列类型校验并全部参数绑定；未知列、类型不匹配在进入引擎前拒绝。`date`/`timestamp`/`json` 的等值过滤在 V1 明确不支持并报错，避免猜测格式导致静默零匹配。
- 决策四：接受反向映射的 O(N) 成本。V1 没有持久化 `business ID → 向量行` 索引，每次过滤查询扫描完整 ID Map；该成本写入文档与诊断（`filteredCandidates`），不包装成性能保证。
- 后果：`capabilities().hybridSearch` 仅在同时存在 Reader 与 SQL Adapter 时为 `true`；ANN 路径未接入，不能声称混合检索在近似索引上有效。

## 明确禁止的未经验证声明

- 不宣称 100 万向量一定在毫秒级完成查询。
- 不宣称浏览器与 Node 具有完全一致的 SQL 功能。
- 不宣称单个 `.wsql` 文件一定能在 CDN 上高效随机读取。
- 不宣称 USearch 的所有目标平台都已支持，必须以实际构建和测试结果为准。
