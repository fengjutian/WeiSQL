# WeiSQL AI

WeiSQL AI 是一个面向静态网站和嵌入式 AI 应用的只读数据运行时实验项目。数据集可以随应用发布到静态托管或 CDN，由浏览器或 Node.js 按需读取，无需单独部署数据库服务。

项目采用 TypeScript + Rust：TypeScript 提供公开 SDK、Manifest 校验、资源读取、Runtime 编排和精确向量检索；Rust 提供用于对照的精确 Cosine 基线。DuckDB、DuckDB-Wasm 和 USearch 被设计为可替换 Adapter，当前只有 SQL 注入契约，仓库内没有任何引擎实现。

> 当前状态：工程原型。Manifest V1 基础结构已冻结；L1/L2 校验、L3 资源完整性（尺寸 + SHA-256）、HTTP 与 Node 文件 Reader、Runtime 生命周期、TypeScript 精确向量检索、生成真实数据包的 Builder 首版，以及 Node.js DuckDB 只读 SQL Adapter 均已实现并有自动化测试。DuckDB-Wasm、ANN 和真实 CDN 部署仍在开发计划中。项目尚未发布 npm 包，也没有未经实测的性能承诺。

## 已实现

- 冻结的 Manifest V1 类型、JSON Schema 和运行时语义校验
- 表、列、主键、向量集合和 ID Map 跨字段引用检查
- 路径穿越、绝对路径、URL scheme、百分号编码和重复资源防护
- 向量及 UInt64 偏移文件字节数公式校验
- 浏览器兼容的 `HttpResourceReader`
- Node.js `NodeFileResourceReader`：包根 containment、符号链接逃逸防护和精确范围读取
- 严格 HTTP Range、`Content-Range`、响应长度、取消和生命周期处理
- `open()` 双 Manifest 来源、`capabilities()`、只读 `state` 和幂等 `close()`
- 引擎无关的 `SqlAdapter` 注入边界（`open({ sqlAdapter })`）
- L3 资源完整性：`verifyChecksums` 的 `manifest`（尺寸）与 `all`（增量 SHA-256 + ID Map 内容）两种模式
- 零依赖增量 SHA-256，浏览器与 Node.js 同一实现
- `buildPackage()` Builder：接收已有 Parquet，生成 Float32、ID Map、真实摘要与 Manifest，暂存区自检后原子发布
- Node.js DuckDB 只读 SQL Adapter（`@weisql/duckdb-adapter`）：真实 SQL 查询、参数绑定、语句级只读边界、L4 Parquet 模式校验与原生取消
- 已接入公开 `vector.search()` 的端到端精确搜索
- Float32 little-endian 向量分块读取
- Cosine、L2、IP 统一距离语义
- 固定容量最大堆 Top-K
- JSONL + UInt64 偏移索引的随机 ID 读取
- 流式 TypeScript 精确搜索正确性基线
- Rust 精确 Cosine 搜索基线

## 尚未实现

- DuckDB-Wasm（浏览器）SQL Adapter（Node.js 端已实现）
- USearch 或其他 ANN Adapter
- Builder 的 CSV/JSON → Parquet 生成与类型推断
- Parquet 内容级校验（L4，需要 SQL 引擎）
- WASM 构建与 TypeScript/Rust 自动黄金数据对照
- Netlify/CDN 的真实 CORS、Range 和缓存验收
- `.wsql` 单文件容器
- 全文检索、混合搜索和 RAG 集成层

## 快速开始

要求：

- Node.js 20 或更高版本
- npm
- 可选：Rust stable，用于运行 Rust 基线

安装并验证 TypeScript 工程：

```bash
npm install
npm test
npm run typecheck
npm run build
```

重新生成示例数据包（`examples/fixture`）：

```bash
npm run fixture
```

该命令调用 Builder，从 `examples/source/documents.parquet` 生成完整数据包并在发布前自检。源 Parquet 由 `python tools/make-source-parquet.py`（依赖 pyarrow）生成，属于不可变输入。

测试监听模式：

```bash
npm run test:watch
```

运行 Rust 基线：

```bash
cargo test --manifest-path crates/vector-benchmark/Cargo.toml
cargo run --release --manifest-path crates/vector-benchmark/Cargo.toml -- 10000 128 10
```

Rust 示例参数依次为向量数量、维度和 Top-K。该程序是确定性正确性与基准实验入口，不是生产 ANN 引擎。

## Manifest V1

数据包的逻辑布局：

```text
weisql-package/
├── manifest.json
├── data/
│   └── documents.parquet
└── vectors/
    ├── embeddings.f32
    ├── id-map.jsonl
    └── id-map.offsets
```

V1 的核心约定：

- `format` 固定为 `weisql`
- `formatVersion` 固定为 `1.0.0`
- 表数据使用 Parquet
- 向量使用 `f32-le-row-major`
- ID Map 使用 UTF-8 JSONL
- 随机访问偏移使用 little-endian UInt64
- Cosine 距离为 `1 - similarity`
- L2 为欧氏距离
- IP 为负内积
- 所有距离越小越相似

完整规范见 [Manifest V1](docs/MANIFEST_SPEC_V1.md)，机器可读结构见 [JSON Schema](docs/MANIFEST_SCHEMA_V1.json)。示例中的大小和摘要是占位值，不对应真实资源。

校验外部 Manifest：

```ts
import { validateManifest } from "@weisql/sdk";

const manifest = validateManifest(JSON.parse(source));
console.log(manifest.datasetId);
```

## HTTP Range 读取

```ts
import { HttpResourceReader } from "@weisql/sdk";

const reader = new HttpResourceReader({
  baseUrl: "https://example.test/datasets/demo/",
});

const bytes = await reader.readRange(
  "vectors/embeddings.f32",
  { start: 0, end: 4096 },
);

await reader.close();
```

Range 使用左闭右开区间 `[start, end)`。服务端必须正确返回 `206 Partial Content` 和匹配的 `Content-Range`；返回 `200` 的整文件响应不会被误当成局部数据。

## 精确向量搜索基线

当前 TypeScript 搜索链路为：

```text
ResourceReader
  → VectorBlockReader
  → Float32 LE 解码
  → Cosine / L2 / IP
  → TopKMaxHeap
  → IndexedIdMapReader
  → 业务 ID 结果
```

搜索只保留一个解码块和 Top-K 候选，并在距离扫描结束后读取最终候选的业务 ID。分块能够降低峰值内存，但不会减少精确搜索的总网络读取量和计算量。

详情见 [TypeScript 精确搜索基线](docs/EXACT_VECTOR_BASELINE.md)。

## 构建数据包

V1 Builder 接收**已存在的 Parquet 文件**（不负责 CSV/JSON 推断），生成 Float32 向量、ID Map、真实字节数与 SHA-256，并在发布前重新读取整个暂存区做 L1/L2/L3 自检：

```ts
import { buildPackage } from "@weisql/sdk";

const report = await buildPackage({
  outputDirectory: "fixture",
  datasetId: "demo-documents",
  tables: [{
    name: "documents",
    parquetPath: "source/documents.parquet",
    columns: [
      { name: "id", type: "string", nullable: false },
      { name: "title", type: "string", nullable: false },
    ],
    primaryKey: ["id"],
    rowIds: ["doc-001", "doc-002", "doc-003"],
  }],
  vectorCollections: [{
    name: "document_embeddings",
    tableName: "documents",
    idColumn: "id",
    metric: "cosine",
    vectors: [[1, 0], [0.9, 0.1], [0, 1]],
    ids: ["doc-001", "doc-002", "doc-003"],
  }],
});
```

构建阶段为 `CREATED → VALIDATING → BUILDING → VERIFYING → PUBLISHING → PUBLISHED`，任一阶段失败进入 `FAILED` 并清理暂存区。默认拒绝覆盖已有目录；`overwrite: true` 时先把旧目录移走，成功后才删除，失败则回滚。

未提供 `rowIds` 时，Builder 不会假装完成主键交叉校验，而是在 `report.warnings` 中报告 `id-membership-unverified`。

## 资源完整性校验

`open()` 的 `verifyChecksums` 有三种策略，语义与 `RESOURCE_INTEGRITY_SPEC.md` 一致：

| 策略 | 行为 |
| --- | --- |
| `none`（默认） | 只做 L1/L2，不访问任何资源 |
| `manifest` | 用 `stat` 校验每个资源实际长度，不做完整读取 |
| `all` | 分块增量计算 SHA-256，并校验 ID Map 偏移与 JSONL 内容 |

`all` 模式会验证字节内容一致性；`manifest` 只保证长度，**不使用 `all` 就无法发现同长度的内容篡改**。完整性校验在任何 Adapter 接触资源之前执行，需要同时提供 `resourceReader`。

## Runtime API

```ts
import { open, HttpResourceReader } from "@weisql/sdk";

const db = await open({
  manifestUrl: "https://example.test/datasets/demo/manifest.json",
  resourceReader: new HttpResourceReader({
    baseUrl: "https://example.test/datasets/demo/",
  }),
});

const hits = await db.vector.search("document_embeddings", query, { topK: 10 });
db.capabilities(); // { sql, vectorExactSearch, vectorAnnSearch, hybridSearch, resourceRange }
await db.close();
```

`manifestUrl` 与已解析的 `manifest` 必须二选一，两条路径都经过同一套运行时校验。注入 `resourceReader` 后，`vector.search()` 执行完整闭环（Range 读取 → Float32 解码 → 距离扫描 → Top-K → Indexed ID Map → 业务 ID），并在 `diagnostics` 中标记 `exact: true`。

未注入 Reader 时返回 `INDEX_NOT_FOUND`，未注入 `sqlAdapter` 时 `sql()` 返回 `SQL_UNSUPPORTED`，两者都不会返回模拟数据。

## SQL 查询

Node.js 端通过独立包 `@weisql/duckdb-adapter` 接入真实 DuckDB，SDK 本身仍然零引擎依赖：

```ts
import { open, NodeFileResourceReader } from "@weisql/sdk";
import { createDuckDbAdapter } from "@weisql/duckdb-adapter";

const db = await open({
  manifestUrl: "https://example.test/datasets/demo/manifest.json",
  resourceReader: new NodeFileResourceReader({ rootDirectory: "./demo" }),
  sqlAdapter: createDuckDbAdapter(),
});

const rows = await db.sql(
  "select id, title from documents where category = ? order by id",
  ["genetics"],
);
```

边界与取舍：

- **只读由引擎的语句分类保证**：只执行 `SELECT` 与 `EXPLAIN` 预处理语句，`INSERT`/`UPDATE`/`DELETE`/`COPY`/`CREATE`/`ALTER`/`SET`/`CALL` 一律返回 `SQL_UNSUPPORTED`。不依赖关键字过滤，`WITH ... DELETE` 同样被拒绝。
- **单语句**：`prepare()` 直接拒绝多语句输入，一次调用无法夹带第二条语句。
- **外部文件访问关闭**：`open()` 最后设置 `enable_external_access=false` 与 `lock_configuration=true`，因此用户 SQL 里的 `read_parquet('/etc/passwd')` 会被拒绝。
- **表会被物化进内存**：为满足上一条边界，Adapter 用 `CREATE TABLE ... AS SELECT` 把 Parquet 载入内存库，而不是保留需要查询期文件访问的视图。内存成本约等于表数据量，由 `maxTableBytes`（默认 256 MiB）兜底。
- **L4 校验**：表载入后按 Manifest 的列名与类型比对 `DESCRIBE` 结果，不一致返回 `RESOURCE_INTEGRITY_FAILED`；可用 `verifyTableSchema: false` 关闭。
- **取消是原生的**：通过 `connection.interrupt()` 中断执行中的查询，能力声明为 `cancellation: "native"`。
- **已知限制**：`DECIMAL` 由驱动转换为 `number`，超过 15 位有效数字会丢精度；可空性不在 L4 比对范围内（`read_parquet` 不保留 `NOT NULL` 约束）。

详见 [DuckDB Adapter](docs/DUCKDB_ADAPTER.md)。

## 仓库结构

```text
crates/vector-benchmark/   Rust 精确 Cosine 基线
docs/                      格式、Adapter、安全、基准和路线文档
examples/manifest/         Manifest 正例与安全负例
examples/source/           Builder 的不可变 Parquet 输入
examples/fixture/          Builder 生成的真实数据包示例
packages/sdk/              TypeScript SDK、资源层、Builder 和向量基线
packages/duckdb-adapter/   Node.js DuckDB 只读 SQL Adapter
tools/                     源 Parquet 生成脚本
```

## 主要文档

- [总体技术规范](docs/TECHNICAL_SPEC_V1.md)
- [工程路线图](docs/ENGINEERING_ROADMAP.md)
- [Manifest V1](docs/MANIFEST_SPEC_V1.md)
- [Manifest Validator 与 Builder 工程规范](docs/MANIFEST_VALIDATOR_BUILDER_SPEC.md)
- [SDK API 契约](docs/SDK_API_CONTRACT_V1.md)
- [V1 公共类型与错误契约](docs/PUBLIC_TYPES_AND_ERRORS_V1.md)
- [SQL Adapter 契约](docs/SQL_ADAPTER_CONTRACT.md)
- [DuckDB Adapter](docs/DUCKDB_ADAPTER.md)
- [Vector Adapter 契约](docs/VECTOR_ADAPTER_CONTRACT.md)
- [ResourceReader 契约](docs/RESOURCE_READER_CONTRACT.md)
- [资源完整性校验规范](docs/RESOURCE_INTEGRITY_SPEC.md)
- [V0.6 Runtime 基础设计](docs/V0_6_RUNTIME_FOUNDATION.md)
- [V0.7 Runtime API 与混合查询设计](docs/V0_7_RUNTIME_AND_HYBRID.md)
- [V0.8 工程分层与 V1 交付范围](docs/V0_8_ENGINEERING_AND_DELIVERY.md)
- [浏览器与 Node.js Runtime 兼容性](docs/RUNTIME_COMPATIBILITY.md)
- [端到端验收计划](docs/E2E_ACCEPTANCE_PLAN.md)
- [V0.5 验收清单](docs/V0_5_ACCEPTANCE.md)
- [基准测试协议](docs/BENCHMARK_PROTOCOL_V1.md)
- [技术决策记录](docs/DECISION_LOG.md)

## 安全边界

- Manifest 和所有远程文件均视为不可信输入。
- 资源路径必须是数据包内的规范相对路径。
- SQL 参数必须使用引擎参数绑定，不允许插值不可信值。
- SHA-256 用于检测内容是否与 Manifest 声明一致，不证明发布者身份。
- 静态数据包默认可被下载，不得包含 API Key、访问令牌或私密数据。
- 示例摘要和字节数仅用于展示格式，不得用于正式发布。

## 开发顺序

当前建议顺序：

1. ~~实现 Builder 和真实三记录 fixture~~（首版已完成，`examples/fixture`）
2. ~~实现 L3 文件长度与 SHA-256 校验~~（已完成，`verifyChecksums`）
3. ~~接入 Node.js DuckDB Adapter~~（已完成，`packages/duckdb-adapter`）
4. ~~完成 SQL + 精确向量搜索端到端测试~~（已完成，见适配器测试）
5. 验证 DuckDB-Wasm 和静态 CDN
6. 在正确性基线稳定后接入 ANN 并运行性能协议

第 5 步是当前瓶颈：浏览器侧还没有任何已验证的引擎路径，Node 端的结论不能外推到 WASM。

在真实测试报告完成前，不对百万级向量延迟、浏览器内存、ANN 召回率或 CDN 随机访问效率作产品承诺。
