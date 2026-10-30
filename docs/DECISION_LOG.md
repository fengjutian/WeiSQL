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

- 状态：Accepted and implemented（两策略）；`vector-first` 的近似性以诊断标注，不做保证
- 决策一：`filter` 在 Top-K **之前**生效。先用 SQL 求出满足条件的完整业务 ID 集合，映射为向量行，再让精确扫描只考虑这些行。反向做法（先取 Top-K 再丢弃不匹配项）在过滤子集较小时会少返回结果，也无法诚实地声明 `exact: true`，因此不采用。
- 决策二：Hybrid 逻辑放在独立 `hybrid-executor.ts`，Runtime 只负责注入依赖与诊断，遵守 V0.8 §4「不进入 Runtime 主类硬编码」。
- 决策三：过滤器只接受 Manifest 白名单中的列，值按列类型校验并全部参数绑定；未知列、类型不匹配在进入引擎前拒绝。`date`/`timestamp`/`json` 的等值过滤在 V1 明确不支持并报错，避免猜测格式导致静默零匹配。
- 决策四：接受反向映射的 O(N) 成本。V1 没有持久化 `business ID → 向量行` 索引，`exact-filter-first` 每次扫描完整 ID Map；该成本写入文档与诊断（`filteredCandidates`），不包装成性能保证。
- 决策五：`vector-first` 先取有界候选窗口再过滤，因此结果只是「候选窗口内的最近 K」。仅当窗口覆盖整个集合时才置 `exact: true`（靠穷尽而非靠构造），并报告 `candidatesScanned` / `filteredCandidates` / `candidateCap`。窗口参数（`initialCandidates`、`expansionStep`、`maxCandidates`）显式可配，默认值写在类型注释里。
- 决策六：`vector-first` 省掉的是全量 ID Map 扫描，不是向量扫描——V1 无 ANN 索引，向量仍需全量过一遍。它的价值在于为后续 ANN 提供正确形状，不宣称性能优势。
- 后果：`capabilities().hybridSearch` 仅在同时存在 Reader 与 SQL Adapter 时为 `true`；ANN 路径未接入，不能声称混合检索在近似索引上有效。

## ADR-019：缓存实现为 Reader 装饰器，取消所有权归调用方

- 状态：Accepted and implemented（`CachedResourceReader`）
- 决策一：缓存是 `ResourceReader` 装饰器，不是各 Reader 的内部逻辑。缓存键必须包含发布版本身份，而 HTTP、Node 文件和未来的 `.wsql` 需要完全一致的淘汰、合并与取消语义；放在装饰器里只需实现一次。
- 决策二：缓存键为 `发布版本身份 + 路径 + start + end`。`setPublicationVersion()` 换版本时整体清空，避免新旧发布的内容混用；不以路径作为唯一键。
- 决策三：取消所有权属于调用方。每个等待者只 reject 自己，底层请求仅在**全部**等待者取消后才 `abort()`。理由：一个急躁的调用方不应破坏另一个调用方正在等的读取。
- 决策四：失败、短读、超预算范围一律不入缓存，且被取消的读取会从 in-flight 表移除。失败的读取不能污染后续同范围请求。
- 决策五：命中返回副本而非缓存内部缓冲。曾以「零拷贝」为默认，测试证明调用方修改返回值会直接改写缓存内容；正确性优先于一次拷贝。
- 决策六：`maxConcurrentReads` 在装饰器层用信号量限制底层并发，避免多个逻辑查询同时打满连接池。
- 后果：`open({ cache })` 默认 32 MiB、单条 1 MiB、并发 8。缓存与 L3 全量校验会互相占用（校验逐块读取并写入缓存），当前未做「校验专用直通」优化；真实 CDN 下的命中率与内存仍需实测，不得据此宣称性能。

## ADR-020：浏览器验收用真实 Chromium 探针，DuckDB-Wasm 受扩展下载阻塞

- 状态：Accepted and implemented（SDK 浏览器路径）；DuckDB-Wasm 验证阻塞
- 决策一：不引入浏览器测试框架堆栈，而是写一个最小探针（`tools/browser-probe`）：Node 静态服务器提供 CORS + Range，Playwright 驱动本机 Chromium 打开页面，页面加载**构建产物** `packages/sdk/dist`（不经过 bundler）并执行真实查询。`npm run probe:browser` 可在失败时返回非零，可接入 CI。
- 决策二：探针必须能证明「按 Range 读」，而不只是「跑通」。服务器记录每个 `Range` 请求并在结束时打印，避免把整文件下载误判为按需加载。
- 决策三：`playwright-core` 只作为 devDependency，浏览器二进制复用本机 Playwright 缓存或系统 Chrome/Edge（`CHROME_PATH` 可覆盖），不下载新的浏览器。
- 决策四：DuckDB-Wasm 的结论只按实测写。实测结果：WASM 在 Chrome 中 577 ms 完成实例化、可注册 HTTP URL，但 `read_parquet` 会从 `extensions.duckdb.org` 下载 parquet 扩展，该主机在本环境不可达，因此浏览器 SQL 路径**未验证**，不得宣称支持。
- 后果（真实 bug）：探针首次运行即暴露 `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation` —— `globalThis.fetch` 被当作分离函数调用，浏览器拒绝、Node 的 undici 容忍。`HttpResourceReader` 与 `open()` 均已改为绑定全局接收者，`test/fetch-binding.test.js` 用会检查 `this` 的 stub 锁定该行为。
- 后果（真实结论）：浏览器路径（Range、L3 校验、精确搜索、缓存、无 Node 全局泄漏）已在 Chrome 中通过；Netlify 部署、WASM 向量搜索与 DuckDB-Wasm 仍未验证。

## ADR-021：校验命令独立成包，退出码即闸门

- 状态：Accepted and implemented（REQ-007，`@weisql/cli`）
- 决策一：CLI 单独成包，只做参数解析、格式化与退出码；校验逻辑仍归 `@weisql/sdk` 的 `validateManifest` 与 `verifyManifestResources`。理由：同一套校验必须被 Runtime、Builder 和 CLI 共用，复制一份逻辑迟早分叉。
- 决策二：`validate` 不打开 Runtime，只回答「这个目录是不是完整自洽的数据包」。SQL 与向量查询不属于校验职责，避免把引擎可用性混进发布闸门。
- 决策三：退出码固定为 `0` 有效 / `1` 无效 / `2` 用法错误，失败细节走 stderr，`--json` 走 stdout。这样 `set -e` 的脚本与 CI 都能直接用，不需要解析文本。
- 决策四：`--mode` 必须如实反映验证级别。`manifest` 模式只比对长度，不能发现同长度篡改；输出中的 `hashesVerified` 会是 `0`，不夸大。
- 决策五：实现使用 `process.exitCode` 而非 `process.exit()`，避免管道场景下 stdout 被截断。
- 后果：`weisql` 目前只有 `validate` 子命令；`inspect`、`build` 等留给后续需求。CLI 未发布到 npm，仓库内通过 `npm run build` 后使用 `node packages/cli/dist/bin.js`。

## ADR-022：示例应用复用探针基础设施，不使用虚构数据

- 状态：Accepted and implemented（REQ-405，`examples/playground`）
- 决策一：Playground 是纯静态页面（HTML + ESM），直接加载 `packages/sdk/dist`，与探针共用同一个静态服务器。不引入框架或 bundler，避免把演示变成第二个构建体系。
- 决策二：查询向量来自数据包本身——页面读取 `vectors/*.f32` 的前三行作为预设，而不是在代码里硬编码 `[1, 0]`。演示必须证明「读到的是包里的字节」。
- 决策三：结果只显示包内真实存在的信息（`row`、业务 `id`、`distance`、诊断）。浏览器端没有 SQL 引擎时，不伪造标题或分类等元数据。
- 决策四：Playground 有自动化验收（`npm run probe:playground`）：真实 Chromium 打开页面、断言初始 Top-3、点击第三个预设后断言 `doc-003` 升到第一。手动演示和回归测试用同一份代码。
- 决策五：诊断区暴露 `backend`、`exact`、耗时与缓存命中/未命中，延续「不夸大」原则：演示页同样标注 SQL 与混合检索在浏览器不可用。
- 后果：Playground 只覆盖向量检索；SQL、混合检索与 Parquet 元数据展示要等 DuckDB-Wasm 阻塞解除。它不是产品级 UI，不承诺可访问性与响应式布局。

## ADR-023：表加载默认物化，惰性视图作为显式取舍

- 状态：Accepted and implemented（REQ-103 部分满足）
- 决策一：默认 `tableLoading: "memory"`（物化 + 关闭外部文件访问）。安全边界不可默认放弃：关闭外部访问后 `read_parquet('/etc/passwd')` 失效，代价是内存约等于表大小，由 `maxTableBytes` 兜底。
- 决策二：新增 `tableLoading: "lazy"`（临时文件 + 视图 + **保留**外部访问），用于大表且 SQL 由应用作者编写的场景。该模式在能力声明中输出 `external-file-access-enabled`，文档明确写出「挡不住读取」，不假装两者兼得。
- 决策三：放弃虚拟文件系统方案——`@duckdb/node-api` 2.0 未暴露注册文件系统的入口；等上游支持后再评估，不用启发式过滤冒充安全边界。
- 决策四：`lazy` 模式必须复用同一套只读语句分类；实测发现 `DELETE FROM <view>` 在 `prepare()` 阶段就失败（`can't delete from a view`），错误码与物化模式不一致，因此 `query()` 增加前置关键字拒绝层，只用于稳定 `SQL_UNSUPPORTED`，真正的边界仍是解析后的 `StatementType`。
- 决策五：视图定义不允许参数绑定（`Unexpected prepared parameter`），`lazy` 模式内联转义后的临时路径；路径来自 `mkdtemp()` 与 Manifest 已验证标识符。
- 后果：REQ-103「大型数据集不应默认整体读入内存」只被部分满足——调用方必须显式选择 `lazy` 并接受其安全代价。两种模式的内存与延迟差异未测量，不得据此宣称性能结论。

## ADR-024：跨环境对照必须比较结果，而不只是分别跑通

- 状态：Accepted and implemented（REQ-403，`npm run probe:parity`）
- 决策一：对照必须由**一个进程**同时驱动两端（Node 直接执行，Chromium 通过 Playwright），否则两边各自「通过」不能证明一致。
- 决策二：查询集与非法 Manifest 用例放在 `tools/browser-probe/parity-queries.mjs`，Node 与浏览器页面导入同一个文件。两个清单分头维护迟早漂移，那样对照就失去意义。
- 决策三：比较 `ids`、`rows`、`exact`、`backend` 完全相等；`distances` 用显式 `1e-6` 容差。浮点不要求逐位一致，但容差必须写在输出里。
- 决策四：非法 Manifest 也必须对照错误码。只比较成功路径会漏掉「两端拒绝方式不同」这类真实兼容性问题。
- 决策五：结论范围写进文档（`ENVIRONMENT_PARITY.md`）：只覆盖 Manifest 校验与精确向量检索；SQL、混合检索、CDN 行为与性能不在其中，不能外推。
- 后果：`probe:parity` 依赖本机 Chromium，未纳入 `npm test`；CI 若没有浏览器会失败，需要显式配置后才可接入。

## ADR-025：基准先交付测量装置，再谈数字

- 状态：Accepted and implemented（REQ-404，`npm run bench`）
- 决策一：先交付**可复现的装置**，而不是一组漂亮数字。装置固定随机种子、报告机器信息、并强制先过完整性闸门；任何人换台机器都能重跑。
- 决策二：合成数据包由 Python + pyarrow 直接写出，而不是走 Builder。原因：Builder 的向量输入要求内存中的数组，10 万 × 128 会产生数千万个 JS 数字。为避免第二个「生成器」偏离格式，生成后必须通过 `validatePackage(mode: "all")` 才允许测量；校验失败直接退出。
- 决策三：所有记录都标注口径：单机、单次、热页缓存（校验已读过全部文件）、不含浏览器、不含 ANN、不含 SQL。数字写进文档时必须连同环境与口径一起写，否则不得引用。
- 决策四：测量包含 I/O 字节与峰值 RSS，而不只是延迟。当前结果已能证明「每次精确查询完整扫描向量文件」（每查询读取字节恰等于向量文件大小）。
- 后果：`bench/` 产出被 `.gitignore` 排除，避免几十 MB 的合成包进入仓库。协议要求的多机复现与冷缓存对照仍未做，因此这些数字只能作为开发期基线。

## ADR-026：ANN 记录为「可行未接入」，默认仍是精确扫描

- 状态：Accepted（探测完成，未实现）
- 决策一：先用探针量化代价，再决定是否接入。实测 `usearch` 2.26.5 在 Node 上可直接使用（含 win32-x64 预编译），建索引、搜索、保存/加载均可用，加载后 Top-1 一致。
- 决策二：默认参数不可接受。`expansion_search=64` 在 100k × 128 随机数据上 Recall@10 = 0.167；要到 1.0 需要 2048，延迟 23.7 ms（精确扫描 151 ms）。因此 ANN 不能作为「透明加速」接入，必须让调用方显式选择并看到 `exact: false`。
- 决策三：索引并不省空间。661 B/向量 vs 原始 256 B/向量，66 MB > 51 MB。任何「ANN 更省内存」的说法必须有实测支撑。
- 决策四：暂不接入，因为缺少三件前提：Vector Adapter 注入契约、Manifest 能描述索引构建参数、按真实数据集测量 Recall@K 的能力。`capabilities().vectorAnnSearch` 保持 `false`。
- 后果：`tools/ann-probe.mjs` 与 `ANN_FEASIBILITY.md` 保留为可复现证据；`usearch` 不进入依赖（`npm i --no-save` 即可复现），避免为未接入的能力增加 24 MB 原生依赖。

## ADR-027：Vector Adapter 由 Runtime 解析过滤，Adapter 只做扫描

- 状态：Accepted and implemented（契约 + 精确参考实现 + 注入点）
- 决策一：请求里传**已解析**的集合描述符与 `allowedRows`，不传 `vectorName` 与 `filter`。过滤语义涉及 Manifest 白名单、类型校验与 SQL 绑定，属于 Runtime；Adapter 拿到行集合后只做「在这些行里找最近邻」，无法自行解释或放宽过滤。
- 决策二：业务 ID 由 Adapter 返回。精确参考实现内部完成行号 → ID 映射；ANN 若无法保证映射必须如实标记 `exactSearch: false`，能力声明决定 `capabilities().vectorAnnSearch`。
- 决策三：注入 `exactSearch: false` 的 Adapter 时，带 `filter` 的检索直接返回 `SQL_UNSUPPORTED`。近似候选的后过滤不能声称为过滤子集的严格最近 K，宁可不支持也不要给出看似正确的结果。
- 决策四：`vector-first` 策略仍只在内置精确管线上可用；把它推广到任意 Adapter 需要候选窗口与行集合的联合语义，留待 ANN 真正接入时再设计。
- 决策五：内置精确管线暂时保留，参考 Adapter 与它并存，测试断言两者结果完全一致。等注入路径在真实使用中稳定后，再把内置管线替换为默认 Adapter，避免一次重构同时改行为和契约。
- 后果：`vectorAdapter` 未注入时行为与之前完全一致（现有 111 个测试全绿）。ANN 仍需索引构建、Manifest 索引参数与召回测量三件前提，本决策只解除了「注入点」这一项。

## ADR-028：ANN 适配器先做内存索引，召回参数必须显式

- 状态：Accepted and implemented（`@weisql/usearch-adapter`）
- 决策一：实现为独立包，通过既有 `VectorAdapter` 注入，SDK 本身不依赖 `usearch`。ANN 用户装一个包，其余用户不受 24 MB 原生依赖影响。
- 决策二：索引在首次检索时现场构建，不加载持久化索引。原因：Manifest 的 `index` 字段缺构建参数，加载时无法复现同一索引；与其假装加载，不如明确 `persistedIndex: false`。
- 决策三：距离在边界处转换，且用 SDK 自身的 `vectorDistance()` 逐条比对验证：`cos` 直接使用，`l2sq` 开方，`ip` 减 1。这三种语义都是从实测得出的，不是从文档抄的。
- 决策四：`expansionSearch` 默认 512 而非 64。实测显示 64 在合成数据上 Recall@10 只有 0.167——延迟好看、结果错误。512 约 0.73，仍然只是一个折中，不代表可承诺的召回率。
- 决策五：带过滤的查询直接拒绝，不做候选后过滤。后过滤既不能给出「过滤子集的最近 K」，也会让诊断中的 `exact: false` 掩盖真实语义。
- 后果：ANN 路径从「契约」变成「有实现」，`capabilities().vectorAnnSearch` 只有在注入该适配器时才为 `true`。持久化索引、按数据集召回评估、ANN+过滤组合语义仍未完成；内存索引的 10 秒构建成本是真实开销，不能被描述成「零成本加速」。

## ADR-029：索引参数进 Manifest，加载失败优于猜参数

- 状态：Accepted and implemented
- 决策一：`vectorCollections[].index` 增加可选 `params`，为扁平数字表（标识符键、最多 32 项、值必须有限数字）。不拆成引擎专用字段：`engine` + `version` 已经确定解释方式，拆字段会让每个新引擎都改一次 Schema。
- 决策二：这是 Schema 的**增量**变更（可选字段），但按项目规则仍必须原子更新：JSON Schema、TypeScript 类型、运行时校验器、格式文档、测试与 ADR 同步完成，否则拒绝合并。
- 决策三：加载方在缺少必需参数时**拒绝加载**，不回退到默认值。用错误的 connectivity/expansion 打开索引不会报错，只会悄悄改变召回率——这比直接失败更危险。
- 决策四：USearch 只能从路径加载，Adapter 因此把资源字节写到私有临时文件，`close()` 时连同临时目录一起删除。这是与 DuckDB Adapter 相同的取舍：引擎不支持内存文件系统时，落地文件是唯一可行路径。
- 决策五：索引文件纳入 L3 校验（`declaredResources` 已包含 `index.file`），`weisql validate` 会对它做尺寸与 SHA-256 校验。索引损坏在发布前就会被发现，而不是等到检索时。
- 后果：`tools/build-ann-index.mjs` 负责生成索引并回写 Manifest（写盘前重新 `validateManifest`）。`capabilities().persistedIndex` 对 USearch 适配器改为 `true`；未声明索引的包仍在首次检索时现场构建。

## ADR-030：ANN 召回必须逐查询报告，均值单独出现即为误导

- 状态：Accepted and implemented（`npm run bench -- --ann`）
- 决策一：ANN 基线测量放在同一进程、同一数据包、同一组查询上完成：先精确扫描得到 ground truth，再用同一批查询跑 ANN，逐查询计算 Recall@K。跨进程或跨数据集比较没有意义。
- 决策二：输出同时保留 `mean`、`min` 与 `perQuery`。100k × 128 实测均值 0.735，但逐查询从 0.400 到 1.000 都有——只报均值会让人误判稳定性。
- 决策三：首次查询单独计时（含完整索引构建，实测 15.2 s），不计入 p50/p95，避免把构建成本混进查询延迟。
- 决策四：装置输出的 caveats 里写明「合成均匀向量是 HNSW 最不利场景，不能预测真实 embedding」。任何引用这些数字的材料必须连同该限制一起引用。
- 后果：ANN 的收益首次有了可复现的数字（约 9.5 倍加速 / 均值 0.735 召回），同时明确小数据量下 ANN 反而更慢（5k 时 11.8 ms vs 精确 10 ms）。性能与召回承诺仍不成立。

## ADR-031：0.x 阶段四个包同步发版，发布前用脚本检查元数据

- 状态：Accepted and implemented（REQ-406）
- 决策一：0.x 阶段 `sdk`、`duckdb-adapter`、`usearch-adapter`、`cli` 同步发版。0.x 的 minor 升级允许破坏性变更，跨包范围匹配过于脆弱；同步发版保证「SDK 0.2 + adapter 0.1」这种没人测过的组合不会流出去。
- 决策二：下游包对 SDK 使用 caret 范围并跟踪本地版本，禁止 `*`。`*` 在本地被 workspace 链接掩盖，发布后会变成「任意版本」——这是最容易漏掉的发布事故。
- 决策三：发布检查做成脚本（`npm run release:check`）而不是清单文档。它校验版本形状、依赖范围、`files`、`main`/`types`/`exports`、README 与 dist 产物；文档只解释「为什么」，脚本负责「是否」。
- 决策四：LICENSE 不在脚本里自动生成或猜测，只持续警告。选许可证是法律决策，不是工程默认值。
- 后果：首次发布前仍有 LICENSE、npm 组织、CI 三项外部阻塞；`probe:*` 与 `bench` 依赖 Chromium/Python，未纳入 CI 之前不能被当作发布闸门。

## ADR-032：全文检索先定评分与分词，索引格式用可核对的 JSONL

- 状态：格式、校验、读取器与生成器已实现；Runtime `text.search()` 待接入（REQ-306）
- 决策一：先实现**无 I/O 的评分核心**（分词 + BM25），因为评分规则与索引格式相互独立，先锁定语义可以避免「格式改了评分也跟着漂」。测试用硬编码的手算值（N=100, df=10, tf=3, dl=50, avgdl=40 → 3.3764）而不是用实现自身反算。
- 决策二：倒排表用 JSONL（一行一个词项含 `postings: [[row, tf], …]`），而不是二进制定点编码。理由与 ID Map 一致：可人工核对、可直接复用 L3 校验与现有 Range 读取。代价是体积，作为未决问题记录，等真实数据再决定是否值得改格式（改格式属于破坏性变更）。
- 决策三：词项行按字节序升序，且 `term` 键必须位于行首，这样 `terms.offsets` + 二分即可定位词项，不必整读倒排表。这条约束由生成器保证，读取器可以据此做单次 Range 读取。
- 决策四：BM25 使用 `k1=1.2`、`b=0.75`，允许 Manifest 覆盖；`N` 与 `avgdl` 取 Manifest 声明值，运行时不得重新统计全库——那会把 O(term) 查询退化成全表扫描。
- 决策五：**BM25 分数越大越相关**，与向量检索「越小越好」相反。这是公开 API 里唯一的反向约定，必须同时出现在类型注释、文档与返回结果说明中，否则调用方一定会排错序。
- 决策六：分词只做 NFC + 小写 + 字母数字切分 + CJK 单字；不引入词干化、停用词或中文分词器。`minLength > 1` 会丢弃全部 CJK 单字，属于预期行为并写入文档，避免使用者以为中文检索坏了。
- 后果：`capabilities()` 暂不暴露全文能力，`text.search()` 未实现——评分核心、索引读取器与生成工具可单独使用，但还不能通过公开 API 调用。剩余步骤（Runtime 接入）按 `FULL_TEXT_SEARCH.md` §7 推进。

## ADR-033：全文索引自带 ID Map，词项排序与比较统一用 JS 字符串序

- 状态：Accepted and implemented
- 决策一：全文索引必须内嵌 ID Map（`idMap: IdMapDescriptor`），不复用向量集合的映射，也不假设行号等于表行号。理由：全文索引按文档行打分，业务 ID 的解析来源必须显式声明；复用别人的映射在「只有文本索引、没有向量」的包里根本不成立。
- 决策二：`idMap.count` 必须等于 `documentCount`，`offsets.bytes` 必须等于 `count × 8`。与向量侧同一套字节公式，避免声明与实际不符。
- 决策三：词项排序与二分比较都使用 JavaScript 默认字符串比较（UTF-16 码元序），而不是 UTF-8 字节序。生成器与读取器必须共享同一规则；两者在星光面字符上不一致，混用会产生「明明存在却查不到」的隐蔽 bug。
- 决策四：`docLengths` 整文件读取。BM25 需要每个候选的文档长度，而按行随机读取会放大 Range 请求数；4 字节/文档的成本可接受并写入文档。
- 决策五：生成器放在 `tools/` 而不是 SDK Builder，因为它需要读 Parquet（`hyparquet` 是 dev 依赖）。Builder 的数据源边界仍是「已有 Parquet + 内存向量」，不为文本索引破例。
- 后果：fixture 上端到端验证通过（`细胞 → doc-003`、`转录 → doc-002`），`weisql validate` 把 5 个文本索引文件一并纳入 L3（9 个资源）。仅 3 篇文档，不能外推长文本或大规模语料的中文检索质量。

## ADR-034：全文检索接入 Runtime，能力按 Manifest 声明与 Reader 双重判定

- 状态：Accepted and implemented（REQ-306 完成）
- 决策一：`text.search()` 作为 `WeiSQLDatabase` 的独立命名空间，不塞进 `vector.search`。两者返回类型不同（`score` 越大越好 vs `distance` 越小越好），合并成一个方法必然要调用方自己判断方向。
- 决策二：`capabilities().textSearch` 只有在「存在 ResourceReader」且「Manifest 声明了 textIndexes」时才为 `true`。只满足一个条件时搜索仍会 `INDEX_NOT_FOUND`，能力声明不能比实际接线更乐观。
- 决策三：`TextIndexReader` 按索引名懒创建并缓存，`close()` 时统一关闭；重复检索不重复打开资源。未知索引名返回 `INDEX_NOT_FOUND`，不静默返回空数组。
- 决策四：`text.search` 默认 `topK = 10`，与向量检索一致；空查询经分词后为空结果，不报错——空查询不是错误，只是没有词项。
- 后果：`capabilities()` 形状发生变化（新增 `textSearch`），属于公开 API 增量；已有测试与浏览器探针同步更新。REQ-307 的 RRF 融合现在具备两种排序来源，但融合本身尚未实现。

## ADR-035：融合用 RRF，只用排名不用分数

- 状态：Accepted and implemented（REQ-307 的融合部分）
- 决策一：融合采用 Reciprocal Rank Fusion（`Σ 1/(k + rank)`，默认 `k = 60`），不做分数归一化。理由：BM25 分数无上界且依赖语料，向量距离随度量不同（cosine ∈ [0,2]，L2/IP 无界），任何「归一化后再加权」都是拍脑袋；排名是唯一可跨来源比较的量。
- 决策二：两路各自**超额取候选**（默认 `max(topK × 4, topK)`），否则融合只能看到两路交集，无法体现“只在某一路靠前”的文档。
- 决策三：`HybridFusionHit` 同时给出 `ranks`（每路 1-based 名次）与 `vector.distance` / `text.score`。只给融合分会让人无法解释排序，也无法在调参时判断是哪一路在起作用。
- 决策四：`fusionSearch` 是独立能力位，不复用 `hybridSearch`。后者特指「向量 + SQL 过滤」的 `exact-filter-first`，两者语义不同，混用会让能力报告失真。
- 决策五：平局按「最好的单路名次」再按插入顺序，保证跨运行稳定；数字 ID 与字符串 ID 用类型感知键区分，避免 `1` 与 `"1"` 被合并。
- 后果：`capabilities()` 再次扩展（新增 `fusionSearch`），相关测试与文档同步更新。融合尚未支持过滤条件，也没有与 ANN 组合；RRF 的 `k` 值未做实验调优，`60` 是文献默认值而非本数据集的最优值。

## ADR-036：RAG 只做证据组装，正文进索引、模型调用留在应用层

- 状态：Accepted and implemented（REQ-307 完成）
- 决策一：全文索引增加可选的 `documents` 资源（行 → 原始文本，JSONL + UInt64 偏移）。RAG 需要正文，而倒排表只有词项；让运行时去读 Parquet 会引入一个非只读、非静态的资源通道，破坏「包内自足」模型。
- 决策二：`documents` 是**可选**的。不需要 RAG 的包不必为正文付出体积；`ragSearch` 能力位按「至少一个文本索引声明了 documents」计算，避免能力声明超配。
- 决策三：`rag.search()` 返回 `evidences`（id、文本、融合名次、每路名次、是否被截断）与预算统计，**不拼接 prompt、不调用模型**。WeiSQL 的边界是「检索与证据」，提示词、引用格式与模型选择属于应用层，换模型不应要求换数据格式。
- 决策四：字符预算按字符数（`maxCharacters`，默认 4000）而不是 token 数。token 依赖具体模型的分词器，SDK 不应假装知道；由调用方按自己的 tokenizer 换算更诚实。
- 决策五：超出预算的文档被截断并标记 `truncated: true`；没有正文或预算已耗尽的命中计入 `droppedHits`，不静默丢弃。
- 后果：`capabilities()` 第三次扩展（`ragSearch`），测试与契约同步更新。端到端实测：`dna` → `DNA 结构`（6 字符），预算 3 时返回 `DNA` 且 `truncated: true`。`documents` 会显著增大包体积（等于文本列大小），生成器必须显式构建，不给默认值。

## ADR-037：ANN 过滤只提供显式后过滤，且必须自曝不完整

- 状态：Accepted and implemented
- 决策一：默认仍然**拒绝**过滤（`filtering: "reject"`）。近似候选列表做后过滤，无法给出「过滤后的真实 Top-K」，这不是实现难度问题，是语义问题。
- 决策二：新增 `postFiltering` 能力位与 `filtering: "post-filter"` 选项，只有适配器显式声明时才允许带 `allowedRows`。默认值不变，已有行为不会悄悄变宽松。
- 决策三：后过滤必须扩大候选窗口并逐步翻倍，直到凑够 topK 或遍历完整个集合；返回数量可以少于 topK，且每条命中必须带 `diagnostics.postFiltered = true` 与 `candidatesScanned`。调用方据此知道结果不完整。
- 决策四：Runtime 在适配器返回后**复核**每一行是否属于 `allowedRows`；越界行抛 `INTERNAL_ERROR`。适配器违反契约时宁可失败，也不能静默扩大结果集。
- 决策五：`hybridSearch` 能力仍要求 `exactSearch`，后过滤不会让过滤语义变成精确；`vector-first` 对 ANN 仍然拒绝。
- 后果：ANN + 过滤从「明确不支持」变为「显式可选、可观测、不保证完整」。`capabilities.postFiltering` 进入公开契约；`metadataFiltering` 仍为 `false`，因为后过滤不满足 V1 过滤语义。

## ADR-038：CI 只做行为闸门，派生索引与 fixture 可复现性单独校验

- 状态：Accepted and implemented（`.github/workflows/ci.yml`）
- 决策一：CI 覆盖「构建 → 类型 → 测试 → 发布元数据 → 示例包校验」，在 Ubuntu 与 Windows 上各跑一遍。Windows 不是可选项：项目主开发环境是 Windows，大小写敏感性、路径分隔符与换行差异只有在两个平台都跑才会暴露。
- 决策二：`probe:*` 与 `bench` **不进 CI**。它们需要 Chromium 下载、Python 与相对稳定的机器，放进去只会制造随机失败；代价是浏览器与性能结论必须在文档里注明「本地、指定环境」，不能借 CI 绿灯暗示已验证。
- 决策三：fixture 可复现性作为独立作业：重新生成后要求 `git status --porcelain` 为空。否则 Manifest 里的 SHA-256 只能证明「文件没被改」，不能证明「生成器可复现」。
- 决策四：派生索引（文本索引、ANN 索引）在 CI 中构建到临时目录并跑 `weisql validate`，不提交产物。它们依赖可选特性，提交后会让每次格式变更都产生大块二进制 diff。
- 后果：CI 用 Node 24（USearch 要求 ≥22，本地为 v24），`npm ci` 依赖 lockfile 严格一致。LICENSE 与 npm 组织仍不在 CI 能力范围内，`release:check` 只警告不阻塞。

## 明确禁止的未经验证声明

- 不宣称 100 万向量一定在毫秒级完成查询。
- 不宣称浏览器与 Node 具有完全一致的 SQL 功能。
- 不宣称单个 `.wsql` 文件一定能在 CDN 上高效随机读取。
- 不宣称 USearch 的所有目标平台都已支持，必须以实际构建和测试结果为准。
