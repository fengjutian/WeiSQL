# WeiSQL AI

WeiSQL AI 是一个面向静态网站和嵌入式 AI 应用的只读数据运行时实验项目。数据集可以随应用发布到静态托管或 CDN，由浏览器或 Node.js 按需读取，无需单独部署数据库服务。

项目采用 TypeScript + Rust：TypeScript 提供公开 SDK、Manifest 校验、资源读取和查询编排；Rust 当前提供精确向量搜索正确性基线。DuckDB、DuckDB-Wasm 和 USearch 被设计为可替换 Adapter，但尚未接入。

> 当前状态：工程原型。Manifest V1 基础结构已冻结，核心校验、HTTP Range 读取和 TypeScript 精确向量搜索已有可运行测试；SQL 引擎、ANN、Builder、WASM 与真实 CDN 部署仍在开发计划中。项目尚未发布 npm 包，也没有未经实测的性能承诺。

## 已实现

- 冻结的 Manifest V1 类型、JSON Schema 和运行时语义校验
- 表、列、主键、向量集合和 ID Map 跨字段引用检查
- 路径穿越、绝对路径、URL scheme、百分号编码和重复资源防护
- 向量及 UInt64 偏移文件字节数公式校验
- 浏览器兼容的 `HttpResourceReader`
- 严格 HTTP Range、`Content-Range`、响应长度、取消和生命周期处理
- Float32 little-endian 向量分块读取
- Cosine、L2、IP 统一距离语义
- 固定容量最大堆 Top-K
- JSONL + UInt64 偏移索引的随机 ID 读取
- 流式 TypeScript 精确搜索正确性基线
- Rust 精确 Cosine 搜索基线

## 尚未实现

- DuckDB / DuckDB-Wasm SQL Adapter
- USearch 或其他 ANN Adapter
- WeiSQL Builder 和真实 Parquet 数据包生成
- 实际资源 SHA-256、完整文件长度和 Parquet 内容验证
- `NodeFileResourceReader`
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

## 仓库结构

```text
crates/vector-benchmark/   Rust 精确 Cosine 基线
docs/                      格式、Adapter、安全、基准和路线文档
examples/manifest/         Manifest 正例与安全负例
packages/sdk/              TypeScript SDK、资源层和向量基线
```

## 主要文档

- [总体技术规范](docs/TECHNICAL_SPEC_V1.md)
- [工程路线图](docs/ENGINEERING_ROADMAP.md)
- [Manifest V1](docs/MANIFEST_SPEC_V1.md)
- [Manifest Validator 与 Builder 工程规范](docs/MANIFEST_VALIDATOR_BUILDER_SPEC.md)
- [SDK API 契约](docs/SDK_API_CONTRACT_V1.md)
- [V1 公共类型与错误契约](docs/PUBLIC_TYPES_AND_ERRORS_V1.md)
- [SQL Adapter 契约](docs/SQL_ADAPTER_CONTRACT.md)
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

1. 实现 Builder 和真实三记录 fixture
2. 实现 L3 文件长度与 SHA-256 校验
3. 接入 Node.js DuckDB Adapter
4. 完成 SQL + 精确向量搜索端到端测试
5. 验证 DuckDB-Wasm 和静态 CDN
6. 在正确性基线稳定后接入 ANN 并运行性能协议

在真实测试报告完成前，不对百万级向量延迟、浏览器内存、ANN 召回率或 CDN 随机访问效率作产品承诺。
