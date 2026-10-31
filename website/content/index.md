---
title: WeiSQL AI 文档
description: 面向静态网站与嵌入式 AI 应用的只读数据运行时：把数据包发布到 CDN，在浏览器或 Node.js 中按需查询。
sidebar_position: 0
---

WeiSQL AI 是一个**只读数据运行时**。它把 Parquet 表、Float32 向量、ID Map 与索引打包成一个可版本化的数据包，随应用发布到静态托管或 CDN；浏览器和 Node.js 通过 HTTP Range 按需读取，不需要单独部署数据库服务。

```text
构建数据包  →  上传到 CDN / 静态托管  →  open()  →  vector / text / hybrid / rag / sql
```

## 我想……

| 目标 | 从这里开始 |
| --- | --- |
| 先搞清楚它适不适合我的场景 | [什么是 WeiSQL AI](/start/what-is-weisql) |
| 5 分钟内跑起来 | [快速开始](/start/quickstart) |
| 理解数据包、Manifest、L1–L4 | [核心概念](/start/concepts) |
| 看整体分层与请求链路 | [架构](/start/architecture) |
| 查技术选型与版本 | [技术栈](/start/tech-stack) |
| 在 Node.js 里查向量 / SQL | [打开与生命周期](/sdk/open-and-lifecycle)、[SQL 查询](/sdk/sql) |
| 在浏览器里做检索 | [资源读取与缓存](/sdk/resource-readers)、[DuckDB-Wasm](/adapters/duckdb-wasm) |
| 构建并校验自己的数据包 | [构建数据包](/tooling/build-package)、[CLI](/tooling/cli) |
| 部署到 CDN / Netlify | [部署到 CDN](/tooling/deploy-cdn) |
| 看哪些能力还没验证 | [限制与路线](/reference/limitations) |

## 能力速览

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Manifest V1 校验（L1/L2） | 已实现 | 结构、路径、跨字段引用 |
| 资源完整性（L3） | 已实现 | 尺寸 + 增量 SHA-256，浏览器与 Node 同一实现 |
| Parquet 内容校验（L4） | 已实现 | CLI `--l4` 或 Adapter 打开时比对列定义 |
| 精确向量检索 | 已实现 | Cosine / L2 / IP，Float32 LE 分块读取 |
| 过滤检索 | 已实现 | `exact-filter-first` 严格；`vector-first` 有界窗口 |
| 全文检索 | 已实现 | BM25，CJK 按字分词 |
| 混合检索 | 已实现 | RRF 按排名融合，`k` 可配 |
| RAG 证据组装 | 已实现 | 字符预算内返回片段，不调用模型 |
| 只读 SQL | 已实现 | Node DuckDB 与浏览器 DuckDB-Wasm 两个 Adapter |
| ANN | 已实现 | USearch HNSW，召回需按数据分布实测 |
| 单文件容器 `.wsql` | 已实现 | 目录或流式读取，gzip 1.1.0 |
| Manifest 签名 | 已实现 | Ed25519、多签、根授权与信任固定 |

:::caution 当前状态
项目仍是**工程原型**（包版本 0.1.0），尚未发布到 npm，也没有未经测量的性能承诺。仓库内 318 个自动化测试覆盖已实现能力；未验证项在[限制与路线](/reference/limitations)中单独列出。
:::

## 文档地图

- **开始**：定位、快速开始、核心概念、架构、技术栈
- **SDK 使用**：生命周期、资源读取、向量、全文与混合、RAG、SQL、容器、完整性与签名、错误
- **适配器**：DuckDB（Node）、DuckDB-Wasm（浏览器）、USearch（ANN）
- **工具链**：CLI、构建数据包、部署到 CDN、基准与浏览器验收
- **参考**：Manifest 速查、能力矩阵、兼容性、限制、术语
- **工程**：文档框架选型 ADR

规范与决策记录保留在仓库 [`docs/`](https://github.com/fengjutian/WeiSQL/tree/main/docs)；本站在需要深挖时给出原文链接，不复制规范全文。
