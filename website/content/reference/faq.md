---
title: 常见问题
description: 关于只读边界、浏览器 SQL、中文搜索、ANN 召回、私有数据、更新方式与 npm 发布的常见疑问。
sidebar_position: 55
hero:
  kicker: "参考 · FAQ"
  title: "先把边界问清楚"
  lead: "哪些事现在能做、哪些明确不做、哪些还需要你自己测量；这里按问题给出直接答案。"
  chips: ["只读", "浏览器 SQL", "ANN", "CDN", "npm"]
hide_title: true
---

## 能力与边界

<details>
<summary>WeiSQL 是数据库吗？</summary>

不是。它是一个**只读数据运行时**：数据包是静态文件，`open()` 读取字节并在客户端完成校验、检索与编排。没有服务端进程、连接、会话或写入路径。

需要事务、并发写入或按用户裁剪数据时，应该使用真正的数据库，而不是 WeiSQL。

</details>

<details>
<summary>能写入、更新或删除数据吗？</summary>

不能。Runtime 只读，底层引擎的写能力被显式关闭。数据更新等于重新构建并发布一份新快照；缓存按发布版本隔离，不会新旧混用。

</details>

<details>
<summary>它和“SQLite 文件 + WASM”有什么区别？</summary>

SQLite 方案把引擎的私有页格式当静态资源；WeiSQL 把数据布局定义成**公开协议**：Manifest + Parquet + Float32 + JSONL，并分层校验。引擎通过 Adapter 注入，因此可以换 DuckDB、DuckDB-Wasm 或 USearch，而不是绑定某一个引擎。

</details>

<details>
<summary>支持哪些托管？Netlify 可以吗？</summary>

任何支持 HTTP Range 与 CORS 的静态托管都可以，包括 Netlify、Cloudflare Pages、S3/OSS + CDN。关键要求是返回 `206 Partial Content`、匹配的 `Content-Range`，并让浏览器能读到这些响应头。

</details>

## 检索与 SQL

<details>
<summary>中文搜索是怎么做的？</summary>

BM25 索引使用 SDK 的 `tokenize()`：Unicode NFC 归一化、转小写，汉字/假名/谚文逐字成为词项。中文召回偏高、精度偏低，这是“可预测”换“分词质量”的取舍；没有停用词表与词干化。

</details>

<details>
<summary>ANN 的召回率为什么不是 100%？</summary>

因为它是近似检索。USearch HNSW 用候选窗口换延迟，结果必须声明 `exact: false`；召回强依赖数据分布，100k × 128 合成数据实测 0.385–0.740。上线前必须用目标语料测 Recall@K。

</details>

<details>
<summary>浏览器 SQL 为什么要加载约 34 MB 的 WASM？</summary>

DuckDB-Wasm 的引擎与 Worker 需要首次下载，parquet 扩展还要单独同源托管。首载成本明显，适合按需加载，不适合阻塞首屏。浏览器端 `open()` 实测 1.37–1.70 s（3 行表、扩展已缓存），大表未测。

</details>

<details>
<summary>SQL 结果很大怎么办？</summary>

用 `db.sqlStream()` 分批迭代，而不是 `db.sql()` 一次性拿数组。`maxRows` 是硬上限，超限会抛 `INVALID_ARGUMENT`，不是分页；需要分页请自己在 SQL 里加 `LIMIT/OFFSET`。

</details>

## 数据与安全

<details>
<summary>可以放私有数据或 API Key 吗？</summary>

不可以。静态数据包默认可以被任何人下载，签名只证明发布者身份，不提供加密或访问控制。API Key、私有 prompt、客户数据不应进入数据包；访问控制应由托管层负责。

</details>

<details>
<summary>签名能防止别人修改数据吗？</summary>

签名绑定 Manifest 与发布者身份；资源内容一致性由 L3 的尺寸与 SHA-256 负责。两者需要同时使用：L3 防损坏，签名证明“谁发布过这个 Manifest”，都不等于加密。

</details>

<details>
<summary>数据包很大，会一次性下载吗？</summary>

目录模式按 `ByteRange` 只读需要的块；`.wsql` 整包模式会下载整个文件，流式模式只读头部再按文件 Range。压缩容器内的 Range 需要先解压整条，会牺牲部分按需读取。

</details>

## 项目状态

<details>
<summary>为什么 npm 上装不到？</summary>

五个包当前都是 `0.1.0`，**尚未发布到 npm**。仓库内可以通过 workspace 构建与引用；发布前包名与导入路径仍可能调整。

</details>

<details>
<summary>现在可以上生产吗？</summary>

精确检索、全文、RRF、RAG、容器与签名已经可以进入生产验证；ANN 召回、真实 CDN 性能、浏览器大表与多机基准仍未验证。不要把仓库里的单机合成数据数字直接写进对外承诺。

</details>

## 还有问题

- 先看[已知限制](/docs/reference/limitations)与[能力矩阵](/docs/reference/capabilities)
- 想直接跑代码：[示例](/docs/examples)
- 想查签名与选项：[API 参考](/docs/api)
