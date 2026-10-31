# WeiSQL AI 工程设计补充与实施路线

- 文档状态：架构建议草案
- 适用范围：TypeScript SDK、Rust Core、DuckDB/USearch 可替换适配器、浏览器/Node.js 运行时、静态数据包与 CDN 发布
- 核心方向：静态网站随包发布、优先只读查询、逐步扩展 AI 检索能力

> 本文定义需要补齐的设计边界和建议实施顺序，不代表所列规范、测试、引擎集成或性能目标已经全部实现。每一项能力必须以代码、自动化测试或实测报告为完成依据。

## 1. 总体原则

WeiSQL AI 不能只完善公开 API、Manifest 和单元测试。数据格式、浏览器资源加载、引擎兼容性、性能验收、安全边界和发布流程必须共同设计，否则底层引擎或分发方式变化时容易造成格式与 API 的破坏性重构。

架构设计遵循以下原则：

1. 公开 API 与 DuckDB、USearch 等具体引擎解耦。
2. 数据、索引和描述信息分层，索引可从原始数据重建。
3. 浏览器端优先消费离线构建的不可变只读数据包，不承担复杂建库任务。
4. 多文件数据包先行；`.wsql` 必须在随机访问和 CDN Range 方案验证后再冻结二进制布局。
5. 功能、兼容性和性能只以自动化测试与可复现实测报告为准。

## 2. 需要补充的十二个方面

### 2.1 Manifest 与数据格式规范（P0）

明确版本兼容规则、必填和可选字段、表结构、数据文件、向量文件、索引文件及校验和。定义未知字段处理方式、格式升级流程和不兼容 Manifest 的识别规则。

计划产物：

- `MANIFEST_SPEC_V1.md`
- `MANIFEST_SCHEMA_V1.json`
- 正例、反例和版本兼容性测试
- 运行时跨字段与资源完整性校验

### 2.2 SQL 与向量引擎适配器契约（P0）

适配器契约必须覆盖参数绑定、结果类型、取消请求、资源释放、错误转换、能力声明和不支持功能的行为，不能只规定接口名称。

计划产物：

- `SQL_ADAPTER_CONTRACT.md`
- `VECTOR_ADAPTER_CONTRACT.md`
- 可复用的适配器一致性测试套件

### 2.3 数据包与单文件 `.wsql` 规范（P0 设计，P3 冻结）

明确多文件数据包与单文件包之间的关系，规定 Manifest、Parquet、向量数据和索引的组织、定位、损坏检查与升级方式。

计划产物：`WSQL_PACKAGE_FORMAT.md`。

在冻结 `.wsql` 二进制布局前，必须验证浏览器和 Node.js 中的读取、目录定位、HTTP Range、缓存及随机访问方案。

### 2.4 浏览器与 Node.js 运行时差异（P1）

明确三种运行模式的能力边界：

- 浏览器 WASM
- Node.js 原生模块
- Node.js WASM

重点验证浏览器资源加载、CORS、HTTP Range、CDN 缓存、跨域资源、内存限制和取消操作。

计划产物：

- `RUNTIME_COMPATIBILITY.md`
- 浏览器集成测试
- Netlify 静态部署示例

### 2.5 性能与内存验收标准（P1）

除结果正确性外，还必须测量冷启动、首次查询、热查询、P50/P95 延迟、内存峰值、索引大小、构建时间和网络下载量。

计划产物：

- `BENCHMARK_PROTOCOL_V1.md`
- 固定且可复现的数据集生成器
- 性能回归报告

百万级向量测试必须同时统计原始向量、索引、查询临时内存及浏览器可用内存，不能只报告搜索延迟。

### 2.6 安全与资源完整性（P0）

在字段校验之外，必须处理路径穿越、超大文件、恶意元数据、损坏索引、字节数或 SHA-256 不匹配，以及 SQL 参数注入风险。

计划产物：

- `SECURITY_MODEL.md`
- 损坏数据和资源限制测试
- SHA-256 与字节数校验
- SQL 参数绑定测试

### 2.7 全文检索与混合搜索（P2）

规划关键词搜索、BM25、向量 ANN、元数据过滤和 RRF 排序融合。统一候选集、评分方向、稳定排序和过滤语义，避免不同引擎产生不一致结果。

计划产物：`SEARCH_SEMANTICS.md` 和混合搜索基准测试。

该阶段在 SQL 与向量接口稳定后实施。

### 2.8 AI / RAG 集成层（P3）

数据库查询与模型调用必须分层：

- 数据库层负责检索、过滤并返回证据；
- AI 层负责 Embedding 接入、上下文组装、来源引用和模型调用。

计划产物：`AI_RETRIEVAL_API.md`。

模型 API Key 不得打包进公开静态数据包。浏览器直连模型服务必须单独评估密钥暴露、配额滥用和服务商 CORS 限制。

### 2.9 TypeScript 与 Rust API 一致性（P0–P1）

统一错误码、距离语义、ID 类型、向量维度、Top-K 约束、取消机制和相同距离时的稳定排序规则。Native 与 WASM 路径使用相同测试向量。

计划产物：

- API 契约测试
- Rust 单元测试
- TypeScript 集成测试
- 跨运行时一致性测试

### 2.10 索引构建、升级与重建（P1）

明确向量生成责任、索引构建时机、索引格式与引擎版本的绑定关系，以及更换引擎后如何从原始向量重建索引。

计划产物：`INDEX_LIFECYCLE.md` 和索引版本兼容测试。

### 2.11 构建、发布与版本管理（P1）

规定 npm 包、Rust crate、WASM 构建、Node.js 原生模块、语义化版本、CI、许可证审查和发布产物校验。

计划产物：

- `RELEASE_PROCESS.md`
- CI 工作流
- 发布清单与产物校验

### 2.12 示例、诊断与可观测性（P1）

提供最小示例、数据包检查命令、引擎能力查询、结构化错误诊断和资源加载日志。诊断信息必须能够区分：

- Manifest 无效
- 文件下载失败
- 大小或哈希不匹配
- SQL 引擎不可用
- 向量索引缺失或损坏

计划产物：完整 `examples/`、诊断 API 和故障排查手册。

## 3. 三项关键架构决策

### 3.1 构建与运行时分离

系统分为两个明确部分。

**WeiSQL Builder**

```text
导入数据 → 生成 Parquet → 处理向量 → 构建索引
        → 生成 Manifest → 校验 → 打包
```

**WeiSQL Runtime**

```text
读取数据包 → 校验 Manifest 与资源 → 按需加载
          → SQL 查询 / 向量搜索 / 混合检索
```

静态网站用户只消费已经构建的数据包，不在浏览器中执行复杂建库任务。

### 3.2 数据与索引分层

数据包分为三层：

- 数据层：结构化记录、原始向量和必要文本内容；
- 索引层：USearch 或其他引擎生成的可替换索引；
- 描述层：Manifest，记录数据与索引的格式、版本、尺寸、摘要和兼容性。

更换索引引擎时，应能使用稳定的数据层重建索引，而不重新生成全部业务数据。

### 3.3 不可变数据包与版本化发布

V1 不支持对公开数据包进行在线写事务。静态数据库更新采用以下流程：

1. 构建新版本数据包；
2. 校验所有数据文件、索引和 Manifest；
3. 上传至新的版本目录；
4. 原子切换入口 Manifest 或版本引用；
5. 保留旧版本，以便缓存失效或发布失败时回滚。

网站访问过程中不得原地修改同一公开数据包。多人写入、同步和事务能力应作为独立的服务端扩展设计。

## 4. 测试矩阵

| 测试类别 | 重点验证 | 优先级 |
| --- | --- | --- |
| Manifest 单元测试 | 字段、类型、引用、版本和路径 | P0 |
| 数据完整性测试 | SHA-256、字节数、损坏文件 | P0 |
| SDK 契约测试 | 错误、参数、生命周期 | P0 |
| SQL Adapter 一致性测试 | 参数绑定、结果映射、取消 | P0 |
| Vector Adapter 一致性测试 | 维度、距离、Top-K、稳定排序 | P0 |
| 浏览器集成测试 | WASM、CORS、Range、缓存 | P1 |
| Native/WASM 对照测试 | 相同输入的结果一致性 | P1 |
| 性能基准测试 | 10 万、50 万、100 万向量 | P1 |
| 混合搜索测试 | BM25、ANN、RRF、过滤 | P2 |
| 发布兼容性测试 | 包版本、引擎版本、升级与回滚 | P1 |

所有性能测试必须记录硬件、运行时、数据集、随机种子、距离度量、索引参数、冷/热缓存状态、内存峰值和原始结果。未实测的数据不得写成性能承诺。

## 5. 建议开发顺序

### P0：锁定契约

范围：Manifest 规范、TypeScript SDK 骨架、Rust Core 基础类型、SQL/Vector Adapter 契约和自动化测试。

验收目标：

- 接口与错误边界清晰；
- 非法输入可稳定识别；
- 契约测试可以在 CI 中执行；
- 具体引擎不会泄漏到公共 API。

### P1：打通真实查询

先接入 DuckDB 完成真实 SQL 查询，再使 Rust 精确向量搜索通过运行时接口工作，随后验证并接入 USearch。此阶段不提前承诺性能指标。

验收目标：真实数据可查询，适配器接口经过至少一个真实实现验证。

### P2：浏览器静态发布

DuckDB-Wasm 与浏览器 SQL 已验证、WASM 向量搜索仍待推进；CDN 按需加载、Netlify 部署和资源完整性检查仍未完成。

验收目标：无需独立数据库服务器，静态网站可以完成真实查询。

### P3：性能和 AI 能力

建立 ANN 基准、混合搜索、RAG 接口、单文件打包验证及发布流程。

验收目标：在可复现的性能与兼容性证据支持下，从嵌入式查询工具扩展为 AI 数据运行时。

## 6. 优先完成的五份核心规范

| 规范 | 状态 |
| --- | --- |
| `MANIFEST_SPEC_V1.md` | 已冻结；L1/L2 校验、L3 完整性与 Builder 均已实现 |
| `SQL_ADAPTER_CONTRACT.md` | 已实现；Node.js DuckDB 与浏览器 DuckDB-Wasm 两个真实实现均通过各自测试 |
| `VECTOR_ADAPTER_CONTRACT.md` | 已实现；精确搜索与 USearch ANN 两个 Adapter 均已接入 |
| `WSQL_PACKAGE_FORMAT.md` | 未单独成文；容器布局已冻结并实现于 `WSQL_CONTAINER.md`（1.0.0 / 1.1.0 gzip） |
| `BENCHMARK_PROTOCOL_V1.md` | 已实现；测量装置可复现运行 |

这些规范共同定义 TypeScript、Rust、DuckDB、USearch 与静态发布之间的协作边界，也决定未来替换底层引擎时能否保持兼容。

其中四份契约已由真实实现验证过；浏览器侧引擎路径已完成，剩余重点是真实 CDN 部署、浏览器大表/冷启动实测与 Native/WASM 黄金数据对照。

## 7. 当前仓库状态（2026-10-31）

本节由实跑验证得出，而非照抄文档自述状态。核对方式：`npm run typecheck`、`npm test`、`cargo test`、`npm run probe:browser`、`npm run probe:wasm`、`npm run probe:playground`、`npm run probe:parity`、`npm run bench`、`npm run bench:wasm` 全部退出码为 0。

| 项目 | 当前状态 |
| --- | --- |
| Manifest JSON Schema | V1 已冻结，`MANIFEST_SCHEMA_V1.json` 与运行时校验同源 |
| TypeScript Manifest 运行时校验 | 已实现；覆盖结构、路径、跨字段引用与字节数公式，含 `textIndexes` |
| TypeScript SDK | 已实现；Manifest、Reader、精确向量 Runtime、Builder、混合检索与全文检索 Runtime 均已接通 |
| 资源读取实现 | `HttpResourceReader`、`NodeFileResourceReader`、有界 LRU 缓存与并发合并均已实现并有自动化测试 |
| L3 资源内容完整性校验 | 已实现；`manifest`（尺寸）与 `all`（增量 SHA-256 + ID Map 内容）两种模式 |
| SQL Adapter | 两个实现均已完成：Node.js DuckDB（语句级只读、原生取消）与浏览器 DuckDB-Wasm（tokenizer 判定的只读边界、`best-effort` 取消、两层字节预算） |
| DuckDB-Wasm | 已实现并在 Chromium 中验证：自托管 parquet 扩展、只读 CTE、过滤检索、`probe:wasm` 断言通过；大表与冷启动未测 |
| USearch ANN Adapter | 已实现；HNSW 内存索引、三种度量映射、`exact: false` 如实标注；召回与延迟对照见 `BENCHMARK_HARNESS.md` |
| 纯 Rust HNSW 备选 | 已实现（`crates/vector-hnsw`，零依赖、种子可复现）：分层图 + 多样性启发式；2000×32 聚类数据 Recall@10 = 1.00、p50 0.048 ms；另有 41 KB WASM 模块（`crates/vector-hnsw-wasm`，1000×16 Recall@10 = 1.00），默认引擎仍是 USearch |
| HNSW Adapter | `createHnswWasmVectorAdapter()` 已实现：`exactSearch: false`、`postFiltering: true`；对精确适配器 Recall@10 ≥ 0.9，距离与 `vectorDistance` 一致，过滤结果均落在 `allowedRows` 内 |
| WASM 向量 Adapter | `createWasmVectorAdapter()` 已实现：整集合缓存 + `allowedRows` 压缩后精确扫描，三度量与零查询错误码均与 TypeScript 精确适配器逐字段对照 |
| ANN 真实数据集召回 | 未评估；现有 Recall@K 均来自合成数据，不能外推 |
| 全文检索 | 已实现；Manifest `textIndexes`、倒排索引读取器、BM25 排序与 Unicode 分词，`text.search()` 已接入 Runtime |
| Rust 向量能力 | 精确 Cosine/L2/IP 基线 + WASM 产物 + HNSW 备选（含 WASM）：57 个测试通过（含 9 个跨语言黄金用例、6 个属性测试、10 个 HNSW 测试）；距离用 `f64` 返回，CI 接入 `fmt`/`clippy`/`test`/release 烟测/WASM 黄金对照 |
| 浏览器路径 | SDK 与 SQL 均已在真实 Chromium 中验证（Range、L3、精确搜索、缓存、DuckDB-Wasm SQL）；Netlify/CDN 未部署 |
| 跨环境对照 | Node 与 Chromium 逐字段对照已通过（8 向量 + 5 文本 + 9 SQL + RAG + 容器 + 6 个 Manifest 错误用例） |
| CI | GitHub Actions 已建立：Ubuntu/Windows 双平台 build→typecheck→test→release:check，另有 fixture 可复现、派生索引、容器、`bench:wasm --smoke`、SQL 契约、Rust 基线作业，以及 Ubuntu 上的 Chromium 探针作业 |
| `.wsql` 容器 | 已实现：pack/validate/unpack、流式 Reader、gzip 1.1.0 |
| 性能结论 | 有可复现的装置与合成数据测量，尚无产品级性能承诺 |
| npm 发布 | 未发布；版本形状与产物检查由 `npm run release:check` 把关 |

