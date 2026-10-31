---
title: WeiSQL AI 是什么
description: 说明 WeiSQL 的定位、适用与不适用场景，以及它与“把数据库放到 CDN 上”的根本区别。
sidebar_position: 10
---

WeiSQL AI 是一个面向静态网站与嵌入式 AI 应用的**只读数据运行时**。读完后，你应该能判断它是否适合你的场景，以及它与你熟悉的“数据库”在边界上有什么不同。

## 一句话定位

数据包随应用一起发布到静态托管或 CDN；浏览器或 Node.js 在需要时读取其中的 Parquet、向量和索引，无需部署数据库服务。SDK 负责校验、读取、编排与检索，SQL 与 ANN 引擎通过 Adapter 注入。

这意味着三件事：

- **没有服务端进程**。部署产物就是一组静态文件，可以用任何静态托管分发。
- **没有连接与会话**。`open()` 读的是字节，不是远程数据库。
- **没有写入路径**。Runtime 只读，底层引擎的写能力被显式关掉。

## 它解决什么问题

常见的静态站点要加“搜索”，通常有三种选择：第三方搜索服务、构建期生成索引、或者干脆只做标题匹配。前两者要么引入外部依赖与费用，要么在数据量上来后把索引塞进首屏包。

WeiSQL 的取舍是：把数据变成**可分块读取的静态资产**，让查询发生在客户端，但又不是“把整个数据集下载下来再过滤”。

适合它的需求长这样：

- 文档站要同时提供关键词检索、语义检索和 RAG 证据片段；
- 产品目录、知识库、法规文本需要离线或内网可用；
- 数据集有明确的发布节奏，每次发布是一份不可变快照；
- 同一份数据要在 Node.js 脚本与浏览器页面里得到一致的排序结果。

## 适用场景

| 场景 | 为什么合适 | 需要接受的代价 |
| --- | --- | --- |
| 文档站的向量 + BM25 + RRF 混合检索 | 精确向量与全文都在 SDK 内，无需外部检索服务 | 向量需全量扫描；延迟随集合规模线性增长 |
| 带类别过滤的语义搜索 | `exact-filter-first` 先过滤再比较，结果仍是严格 Top-K | 需要注入 SQL Adapter |
| 站内问答的证据组装（RAG） | `db.rag.search()` 在字符预算内返回带来源的片段，不调用模型 | 需要全文索引携带原文；模型与 prompt 由应用自己负责 |
| 离线演示、内网工具、Edge 部署 | 数据包是普通文件，不依赖数据库运行时 | 包体积受托管与首载限制 |
| 数据快照分发 | Manifest 冻结、摘要可校验、可签名 | 更新意味着重新构建并发布 |

## 不适用场景

明确说清楚，比含糊地“也能做”更有用：

- **需要写入、事务或多用户并发**。V1 没有写路径，也没有锁与隔离级别。
- **需要按用户权限裁剪数据**。数据包默认可以被任何人下载，权限只能在托管层做粗粒度控制。
- **需要秒级更新的数据**。数据是构建产物，更新等于重新发布。
- **要把 API Key、私有 prompt 或客户数据放进包里的场景**。静态包可公开下载，这类内容不应进入数据包。
- **要求百万级向量固定低延迟的场景**。仓库没有这类承诺，真实数据集上的召回与延迟也未验证。
- **要求浏览器端完整 SQL 方言对等**。Node 与浏览器用的是不同引擎构建，能力边界不同。

## 与“把数据库放 CDN 上”的区别

这句话常被用来描述两类完全不同的东西。

第一类是**把数据库文件当静态资源下发**：例如把一个 SQLite 文件放到 CDN，浏览器下载后交给 WASM 引擎。它省掉了服务端，但格式仍是引擎私有页结构，结构约束、完整性与查询能力都绑在那一个引擎上。

第二类是**把数据库做成 HTTP 服务**，只是部署在 CDN 边缘。它仍然是一个需要凭证、连接和可用性承诺的服务。

WeiSQL 两者都不是。它的核心不是“把引擎搬进浏览器”，而是**把数据布局变成可校验的公开协议**，让引擎成为可替换的实现细节。

| 维度 | CDN 上的数据库文件 | WeiSQL 数据包 |
| --- | --- | --- |
| 格式 | 引擎私有页格式 | 公开协议：Manifest + Parquet + Float32 + JSONL |
| 读取方式 | 通常整文件下载 | 按 `ByteRange` 取需要的块 |
| 结构校验 | 由引擎隐式完成 | L1–L4 分层校验，失败即拒绝 |
| 写入 | 引擎具备写能力，靠部署约束限制 | 无写路径，Runtime 只读 |
| 查询 | 绑定单一引擎 | SQL 引擎可注入；无引擎仍可精确向量、全文与 RAG |
| 权限 | 依赖下载权限 | 包默认公开，敏感数据不得入包 |
| 更新 | 替换文件 | 重建并发布新版本，缓存按版本隔离 |

代价也很具体：你需要一个构建步骤生成数据包，需要接受只读，需要为过滤查询注入 SQL Adapter，也需要自己承担首载体积。

## 能力一览

下面只给结论，状态与实测条件见 [能力矩阵](/docs/reference/capabilities)。

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| Manifest 校验（L1/L2） | 已实现 | 结构、引用、路径、字节公式 |
| 资源完整性（L3） | 已实现 | 尺寸与增量 SHA-256 |
| Parquet 内容校验（L4） | 已实现 | 经 DuckDB Adapter 比对列名与类型 |
| HTTP / Node 文件读取 | 已实现 | Range 严格校验、包根 containment |
| 有界 LRU 缓存 | 已实现 | 请求合并、版本隔离 |
| 精确向量检索 | 已实现 | 分块读取 + 最大堆 Top-K |
| 过滤混合检索 | 已实现 | `exact-filter-first` 与 `vector-first` |
| 全文检索（BM25） | 已实现 | CJK 逐字分词 |
| RRF 融合与 RAG 证据 | 已实现 | 只做排名融合与片段组装 |
| SQL（Node / 浏览器） | 已实现 | 两个独立 Adapter，能力不等价 |
| ANN（USearch） | 已实现 | 必须自报 `exact: false` |
| `.wsql` 单文件容器 | 已实现 | 可选 gzip，支持流式读取 |
| Ed25519 签名 | 已实现 | 多签、轮换、根密钥授权 |

## 技术构成

- **TypeScript**：公开 SDK、Manifest 校验、资源读取、Runtime 编排、精确向量、全文、融合、RAG、Adapter 注入边界。
- **Rust**：精确 Cosine 搜索的对照基线，用于正确性与性能实验，不是生产 ANN 引擎。
- **Adapter**：DuckDB（Node.js）、DuckDB-Wasm（浏览器）承担 SQL，USearch 承担 ANN。SDK 本身零引擎依赖。

依赖方向是单向的：`@weisql/sdk` 不依赖任何 Adapter 包，应用通过 `open({ sqlAdapter })` 或 `open({ vectorAdapter })` 注入。

## 它是怎么工作的（30 秒版）

1. 构建阶段把 Parquet、向量、ID Map 与可选索引写成一个目录，计算每个文件的字节数与 SHA-256，生成 `manifest.json`；
2. 发布时把整个目录（或一个 `.wsql`）上传到静态托管，相对路径保持不变；
3. 应用调用 `open()`，Runtime 先做 L1/L2 校验，按需做 L3；
4. 查询时通过 `ResourceReader` 按 `ByteRange` 读取需要的块，SDK 解码、计算、排序；
5. SQL 与 ANN 交给注入的 Adapter，能力与错误由 Runtime 归一化后返回。

## 一段最小代码

```ts
import { open, HttpResourceReader } from "@weisql/sdk";

const db = await open({
  manifestUrl: "/datasets/demo/manifest.json",
  resourceReader: new HttpResourceReader({ baseUrl: "/datasets/demo/" }),
  verifyChecksums: "all",
});

const hits = await db.vector.search("document_embeddings", queryVector, {
  topK: 5,
  filter: { category: "genetics" },
});

console.log(hits.map(hit => hit.id));
console.log(db.capabilities());
await db.close();
```

这段代码没有后端、没有连接字符串、没有凭证。`filter` 需要注入 SQL Adapter；未注入时返回 `SQL_UNSUPPORTED`，不会静默忽略过滤条件。

## 现状声明

这是**工程原型**，不是已发布产品：

- Manifest V1 的基础结构已冻结，改动需要通过格式版本演进；
- 五个包版本均为 `0.1.0`，**尚未发布到 npm**；
- 自动化测试与浏览器探针覆盖了主要路径，但真实数据集、真实 CDN 与多机基准仍未完成；
- 仓库里出现的性能数字都带条件（规模、维度、环境），不能外推到其他场景；
- ANN 召回强依赖数据分布，未经你的数据测量就不应写进产品承诺。

## 接下来读什么

- 想先跑起来：[快速开始](/docs/start/quickstart)
- 想建立正确的心智模型：[核心概念](/docs/start/concepts)
- 想看整体分层：[架构总览](/docs/start/architecture)
- 想确认某项能力是否可用：[能力矩阵](/docs/reference/capabilities)
- 想知道哪些事还没做：[已知限制](/docs/reference/limitations)
