---
title: 术语表
description: 统一 WeiSQL 文档中的 25 个核心术语，避免“索引”“校验”“精确”等词在不同页面含义漂移。
sidebar_position: 54
---

同一批概念在不同页面反复出现，这里给出一份口径。术语按“数据与格式、校验、运行时、检索”四组排列，共 25 条。

## 数据与格式

| 术语 | 含义 | 容易混淆的点 |
| --- | --- | --- |
| 数据包（package） | 一个目录或一个 `.wsql` 文件，包含 Manifest 与全部资源；是发布与缓存的基本单位 | 不是数据库实例，没有连接与会话 |
| Manifest | 描述表、向量集合、全文索引、资源路径与摘要的 JSON | 它是跨引擎的数据契约，不是 DuckDB 配置 |
| `formatVersion` | 数据包协议版本，V1 固定 `1.0.0` | 数据内容更新不改变它；格式变更才升版本 |
| `datasetId` | 稳定的数据集身份，如 `product-docs` | 与发布版本不同：同一 `datasetId` 可以有多次发布 |
| 发布版本身份（publication version） | 一次不可变快照的标识，由部署层管理 | V1 Manifest 不内嵌该字段；缓存按它隔离 |
| 向量集合（vector collection） | 一组同维度、同度量的向量，绑定到一张表和主键列 | 不是数据库里的“表”，向量与业务行通过 ID Map 对应 |
| ID Map | 行号到业务 ID 的映射，JSONL + UInt64 偏移索引 | 行号从 0 连续递增，与向量行一一对应 |
| `.wsql` 容器 | 把整个数据包打成单个文件的容器格式，1.0.0 未压缩、1.1.0 逐条目 gzip | 不是新数据格式，读取语义与目录模式一致 |

## 校验

| 术语 | 含义 | 容易混淆的点 |
| --- | --- | --- |
| L1 结构校验 | JSON 类型、必填字段、未知字段、版本标识 | 不读取任何资源，可在下载数据前失败 |
| L2 语义校验 | 名称、跨字段引用、路径安全、计数与字节公式 | 向量字节公式 `count × dimension × 4` 在这一层执行 |
| L3 资源完整性 | 实际长度与 SHA-256，`all` 模式还校验 ID Map 内容与偏移 | `manifest` 模式只比长度，发现不了同长度篡改 |
| L4 引擎校验 | Parquet 可读性，列名与类型是否与 Manifest 一致 | 发生在 SQL Adapter 打开时（CLI 用 `--l4`）；不校验可空性 |
| Ed25519 签名 | 对“去掉 `signature` 后的规范化 Manifest”的签名 | 不属于 L1–L3；证明未被篡改，不自动证明发布者可信 |

## 运行时

| 术语 | 含义 | 容易混淆的点 |
| --- | --- | --- |
| Runtime | `open()` 返回的只读对象，持有 Manifest、Reader 与 Adapter 的生命周期 | 它不是引擎；`capabilities()` 报告的是本实例的接线情况 |
| ResourceReader | 唯一接触字节的抽象，提供 `read` / `readRange` / `stat` / `close` | 由注入方创建，由 Runtime 负责关闭 |
| `ByteRange` | 左闭右开区间 `[start, end)` | 空范围不触发 I/O；短读必须失败 |
| Adapter | 可注入的引擎实现，SDK 本身零引擎依赖 | 不注入时明确报错，不返回模拟数据 |
| `SqlAdapter` | SQL 引擎边界，`open({ sqlAdapter })` 注入 | 浏览器与 Node 是两个不同实现，能力不等价 |
| `VectorAdapter` | 向量检索引擎边界，`open({ vectorAdapter })` 注入 | ANN 实现必须声明 `exactSearch: false` |
| 物化（materialize） | 把 Parquet 载入引擎内存表，而不是保留查询期文件访问 | 内存成本约等于表数据量；`lazy` 模式是另一种取舍 |

## 检索

| 术语 | 含义 | 容易混淆的点 |
| --- | --- | --- |
| 精确检索（exact search） | 扫描全部候选并做严格 Top-K，结果可声明 `exact: true` | 分块读取降低峰值内存，但不减少总 I/O 与计算量 |
| ANN | 近似最近邻检索，用召回换延迟 | 结果不保证是真实最近邻；必须如实标注 `exact: false` |
| Recall@K | 近似结果与精确 Top-K 的重合比例 | 强依赖数据分布；不写分布与规模的召回数字没有意义 |
| BM25 | 全文检索的排序函数，分数越大越相关 | 与向量距离方向相反：距离越小越好，BM25 分数越大越好 |
| RRF | Reciprocal Rank Fusion，只按排名融合多路结果 | 融合分数不能与 BM25 分数或向量距离直接比较 |
| RAG | 检索增强生成的“检索”部分：按预算组装带来源的证据片段 | `db.rag.search()` 不调用模型、不拼 prompt |

## 两个常用参数

| 名称 | 含义 | 边界 |
| --- | --- | --- |
| `topK` | 返回的结果条数 | 必须是正整数；默认 10，受实现与资源限制约束 |
| `maxRows` | SQL 结果行数预算 | 超限抛 `INVALID_ARGUMENT`，不静默截断 |

## 术语之间的关系

把 25 个词放回一张图里，关系比定义更好记：

```text
数据包（静态字节，发布单位）
  ├─ manifest.json ── 声明 ──> 表 / 向量集合 / 全文索引 / 资源
  ├─ data/*.parquet ── L4 比对 ──> 表
  ├─ vectors/*.f32 + ID Map ──> 精确检索 / ANN
  └─ text/* + documents ──> BM25 / RAG

ResourceReader ── ByteRange ──> 数据包
Runtime ── 注入 ──> SqlAdapter（SQL）
Runtime ── 注入 ──> VectorAdapter（ANN）
Runtime ── 内置 ──> 精确检索 / BM25 / RRF / RAG
```

三条读图规则：

1. **越往下越“笨”**。ResourceReader 只认字节和区间，不理解表、向量或 SQL。
2. **越往上越“聪明”，也越可替换**。同一份数据包可以接 DuckDB、DuckDB-Wasm 或 USearch，上层 API 不变。
3. **校验与检索是两条正交的线**。L1–L4 决定“能不能用这些字节”，检索决定“用这些字节算出什么”。

## 常见缩写

| 缩写 | 全称 | 文档中的含义 |
| --- | --- | --- |
| ANN | Approximate Nearest Neighbor | 近似最近邻检索，用召回换延迟 |
| BM25 | Best Matching 25 | 全文检索的排序函数 |
| CJK | Chinese, Japanese, Korean | 中日韩文字；当前按字分词 |
| COI | Cross-Origin Isolation | 跨源隔离，多线程 WASM 的前提 |
| HNSW | Hierarchical Navigable Small World | USearch 使用的图索引结构 |
| LE | little-endian | 字节序；向量与 UInt64 偏移都固定为 LE |
| OPFS | Origin Private File System | 浏览器端私有文件系统，当前未实现 |
| RAG | Retrieval-Augmented Generation | 这里只指检索与证据组装，不含生成 |
| RRF | Reciprocal Rank Fusion | 按排名融合多路检索结果 |
| SPKI | Subject Public Key Info | 公钥编码格式，签名与 `keyId` 使用 |
| WASM | WebAssembly | 浏览器端 SQL 引擎的运行形态 |

## 写法约定

- **Manifest、Adapter、Runtime、Reader** 保留英文并首字母大写，不逐字翻译。
- **格式版本**（`formatVersion`）与**发布版本**（publication version）必须分开写，不要混用“版本”。
- **距离**越小越相似；**BM25 与 RRF 分数**越大越相关。两者不可直接比较。
- 提到 API 时用代码格式，例如 `open()`、`db.vector.search()`、`capabilities()`。
- 状态词只用四个：已实现、已测试、未验证、未实现；不要用“基本可用”“理论上支持”。

## 关于“向量数据库”

文档里几乎不使用“向量数据库”这个词。它暗示一个提供连接、写入与索引管理的服务，而 WeiSQL 的向量部分只是静态文件上的检索：没有服务、没有写入、没有独立进程。

需要指代数据时用“向量集合”，指代能力时用“向量检索”，指代近似实现时用“ANN”。

术语口径以本页为准。页面里出现的“包”“数据包目录”“单文件包”都指同一个发布单位；若某页与这里冲突，以本页与源码为准。

## 三组最易混的说法

**“索引”**：文档里至少指三种东西——ANN 索引文件（`index`）、全文倒排（`textIndexes`）、ID 反向索引（`idIndex`）。看到“索引”先确认是哪一种。

**“精确”**：`exact: true` 是运行时诊断字段，表示这一次结果在策略上严格；它不代表数据本身正确，也不代表 ANN 被禁用。

**“校验通过”**：只说明走到了哪一层。默认 `verifyChecksums: "none"`，通过的是 L1/L2；要覆盖内容必须显式开 L3。

## 相关页面

- [核心概念](/start/concepts)
- [Manifest 字段速查](/reference/manifest)
- [能力矩阵](/reference/capabilities)
- [环境与引擎兼容性](/reference/compatibility)
