---
title: 技术栈
description: WeiSQL 的语言、引擎、数据格式与工具链选型，以及每一项选择换来的能力和代价。
sidebar_position: 14
---

WeiSQL 的选型围绕一个目标：**让数据包在浏览器和 Node.js 之间保持同一套语义，同时不把任何数据库引擎焊进 SDK**。下面按层列出选择、版本与边界。

## 1. 总览

| 层 | 选择 | 版本 | 作用 | 边界 |
| --- | --- | --- | --- | --- |
| 语言 | TypeScript | ^5.9.3 | SDK、校验、Reader、Runtime、检索 | 编译为 ESM，浏览器与 Node 共用 |
| 运行时 | Node.js | 20+（开发用 24） | 构建、测试、CLI、Node Adapter | 浏览器不跑 Node API |
| 包管理 | npm workspaces | npm 11 | 5 个发布包 + 示例 + 工具 | 依赖方向单向，`release:check` 强制 |
| 表存储 | Apache Parquet | — | 列式数据、列裁剪、跨引擎 | 由 DuckDB / hyparquet 读写 |
| 向量格式 | Float32 LE row-major | V1 固定 | 精确检索与 ANN 输入 | 不支持 f16/i8（量化仅实验） |
| ID Map | UTF-8 JSONL + UInt64 LE 偏移 | V1 固定 | 业务 ID ↔ 向量行 | 随机读依赖偏移索引 |
| Node SQL | `@duckdb/node-api` | 2.0.0-r.1 | 真实只读 SQL | 原生绑定，不可用于浏览器 |
| 浏览器 SQL | `@duckdb/duckdb-wasm` | 1.32.0 | Worker 内 SQL | 首载约 34 MB，扩展需同源 |
| ANN | `usearch`（HNSW） | 2.26.5 | 近似最近邻 | 召回不保证，需按分布实测 |
| 对照基线 | Rust | stable | 精确 Cosine 正确性参照 | 不是生产运行时 |
| 校验 | JSON Schema + 手写语义校验 | V1 | L1/L2 | 目标态规范与实现有差异 |
| 摘要 | 零依赖增量 SHA-256 | — | L3 资源完整性 | 只证明一致性，不证明来源 |
| 签名 | Ed25519（WebCrypto） | — | Manifest 发布者身份 | 密钥管理由使用方负责 |
| 测试 | `node:test` + Playwright + cargo test | — | 321 个自动化测试 | 性能数字仍需本地复现 |
| 文档 | Docusaurus + jieba 搜索 | 3.10 | 本站 | 见[选型 ADR](/docs/engineering/docs-framework-adr) |

## 2. 包与依赖方向

```text
@weisql/sdk 0.1.0                零运行时依赖
├── @weisql/duckdb-adapter 0.1.0        @duckdb/node-api 2.0.0-r.1
├── @weisql/duckdb-wasm-adapter 0.1.0   @duckdb/duckdb-wasm 1.32.0
├── @weisql/usearch-adapter 0.1.0       usearch 2.26.5
└── @weisql/cli 0.1.0                   复用 SDK 的校验逻辑
```

依赖只能从上往下：Adapter 依赖 SDK，SDK 不反向依赖任何 Adapter。`npm run release:check` 会检查 workspace 依赖范围、`files` 清单、dist 产物与 README 是否齐备。

## 3. 为什么是 TypeScript

- **同一份实现跑两端**：Reader、校验、精确检索、BM25、RRF、RAG 都是纯 TypeScript，浏览器与 Node 行为一致，跨环境对照（`probe:parity`）才有意义。
- **零运行时依赖**：`@weisql/sdk` 不把 DuckDB、USearch、Node API 带进使用方，安装体积与供应链面都可控。
- **类型即契约**：公开类型与错误码在 `packages/sdk/src/types.ts` 中集中定义，文档里的参数名可以直接对照源码。

代价是精确向量扫描受 JavaScript 数值与单线程限制。V1 的选择是“先保证语义正确”，把性能问题交给分块、缓存、索引与 ANN，而不是提前引入原生扩展。

## 4. 为什么引擎是 Adapter

DuckDB 很强，但把它写进 SDK 会带来三个问题：浏览器与 Node 的绑定不同、WASM 体积不可忽略、SQL 方言会泄漏到公开 API。因此：

- `SqlAdapter` 只定义 `open / prepare / query / cancel / close / capabilities`；
- `VectorAdapter` 只定义搜索请求与能力声明；
- 公开 API 不暴露 DuckDB 的连接、Relation、扩展类型；
- 能力差异用 `capabilities()` 报告，而不是假装完全对等。

这也解释了为什么没有注入 Adapter 时返回 `SQL_UNSUPPORTED` / `INDEX_NOT_FOUND`：**缺能力就说缺，不静默降级**。

## 5. 为什么还需要 Rust

`crates/vector-benchmark` 是独立 crate，做两件事：

1. 用确定性数据验证 TypeScript 的 Cosine / L2 / IP 计算与 Top-K 选择；
2. 给出一个不依赖 JS 运行时的性能参照。

它不参与打包、不被 SDK 引用，也不是生产 ANN 引擎。把“参照实现”和“运行时”分开，是为了避免为了对照而把 Rust 工具链变成使用方的硬依赖。

## 6. 明确没有选的东西

| 方案 | 为什么不用 |
| --- | --- |
| 内置 SQLite / DuckDB 到 SDK | 破坏零引擎依赖与浏览器/Node 同构 |
| 服务端查询 API | 与“静态托管、无后端”的定位冲突 |
| Rust/WASM 重写核心检索 | 收益未测，构建与调试成本先到位 |
| 默认启用 ANN | 召回强依赖数据分布，必须先让使用方显式选择 |
| 自研压缩格式 | `.wsql` 先用 gzip 1.1.0；brotli 需要新版本号与 ADR |
| Algolia 作为唯一搜索 | 需要外部服务与审核；文档站改用构建期 jieba 索引 |

## 7. 版本与兼容性

| 项 | 要求 |
| --- | --- |
| Node.js | 20+；DuckDB Node Adapter 依赖平台预编译绑定 |
| 浏览器 | Chromium 已做探针；Firefox/Safari 未验证 |
| DuckDB Node | 2.0.x（`@duckdb/node-api` 2.0.0-r.1） |
| DuckDB-Wasm | 1.32.0；parquet 扩展版本必须与 WASM 核心一致 |
| USearch | 2.26.5；索引与 Adapter 版本兼容策略尚未完成 |
| 数据包格式 | Manifest `1.0.0`；容器 `1.0.0` / `1.1.0` |

更细的差异见[兼容性](/docs/reference/compatibility)。

## 8. 开发命令

| 命令 | 用途 |
| --- | --- |
| `npm run build` | 按依赖顺序构建 5 个包 |
| `npm test` | 构建后运行全部测试 |
| `npm run typecheck` | 全 workspace 类型检查 |
| `npm run fixture` | 重新生成 `examples/fixture` |
| `npm run probe:browser` | Chromium 中验证 Range、L3、精确检索与缓存 |
| `npm run probe:wasm` | Chromium 中验证 DuckDB-Wasm |
| `npm run probe:parity` | Node 与 Chromium 逐字段对照 |
| `npm run bench` | 合成数据包基准（p50/p95、I/O、内存） |
| `npm run release:check` | 发布前静态检查 |

## 9. 已知的选型代价

- **浏览器 SQL 首载重**：WASM 约 34 MB，扩展还需同源托管；实测 `open()` 1.37–1.70 s（3 行表、扩展已缓存），大表未在浏览器验证。
- **精确检索是 O(N)**：100k × 128 实测 p50 129–152 ms、51.2 MB I/O/查询；这不是“毫秒级”承诺。
- **ANN 召回不稳定**：同一份 100k × 128 数据，均匀分布约 0.735，紧聚类低至 0.385；必须用目标数据复测。
- **原生依赖**：DuckDB Node Adapter 与 USearch 都有平台二进制，CI 需要对应平台。

延伸阅读：[工程分层与 V1 交付范围](https://github.com/fengjutian/WeiSQL/blob/main/docs/V0_8_ENGINEERING_AND_DELIVERY.md)、[项目状态报告](https://github.com/fengjutian/WeiSQL/blob/main/docs/PROJECT_STATUS.md)。
