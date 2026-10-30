# WeiSQL AI V1 技术规范（草案）

- 文档状态：设计草案，尚未由可运行原型验证
- 版本：0.1.0-draft
- 项目定位：面向静态网站和嵌入式场景、可随应用发布的只读 AI 数据库
- 目标运行环境：浏览器（WASM）、Node.js；静态发布目标包含 Netlify/CDN

## 1. 目标与非目标

### 1.1 V1 目标

1. 读取静态发布的数据集，无需部署独立数据库服务。
2. 提供 TypeScript SDK，统一访问结构化数据、向量检索和混合搜索。
3. 复用成熟引擎，而非从零实现完整 SQL 引擎或 ANN 算法。
4. 同一数据集尽可能在 Node.js 与浏览器中获得一致的语义结果。
5. 支持多文件目录发布，并保留 `.wsql` 单文件打包的设计空间。
6. 通过可复现基准测试验证正确性、召回率、延迟、内存与文件体积。

### 1.2 V1 非目标

- 多用户并发写入、分布式事务和服务器端同步。
- 替代所有 SQLite 使用场景；尤其不承诺浏览器端完整的 SQLite 式事务语义。
- 自研通用 SQL 解析器、优化器或完整向量数据库。
- 未经测试承诺百万级向量的固定查询延迟。
- 将模型 API Key 或私密数据打包进可公开下载的数据集。

## 2. 架构

```text
Static host / CDN
  ├── manifest.json
  ├── records/part-*.parquet
  ├── vectors/part-*.f32 (或经验证的其他格式)
  ├── indexes/* (引擎原生持久化格式，待验证)
  └── optional: database.wsql
             │
             ▼
      TypeScript SDK
       ├── Manifest & integrity validation
       ├── SQL adapter ── DuckDB-Wasm (browser) / DuckDB Node API
       ├── Vector adapter ── USearch candidate / alternative backend
       ├── Hybrid ranker ── RRF
       └── Resource lifecycle / cancellation / diagnostics
```

职责边界：

- TypeScript：公开 API、Manifest 校验、数据源解析、过滤与结果合并、错误归一化。
- DuckDB：结构化查询与 Parquet 读取；浏览器端使用 DuckDB-Wasm。
- 向量适配层：统一向量索引的构建、保存、加载和 Top-K 查询接口。
- Rust：只有在成熟库无法满足跨平台、性能或格式要求时，才承担自研核心；先建立精确搜索基线。
- WASM 与原生模块是不同构建产物。不得假定同一依赖在浏览器和 Node.js 中具有相同能力。

## 3. 数据包布局

推荐的开发与静态发布形态：多文件数据包。`.wsql` 是可选的分发容器，不是首阶段唯一读取路径。

```text
my-dataset/
  manifest.json
  records/
    part-00000.parquet
  vectors/
    part-00000.f32
  indexes/
    vector.index       # 名称和内容由实际选定的引擎决定
  text/
    lexical-index.*    # 具体格式待全文检索选型
```

所有路径均相对于 Manifest 所在目录解析。路径必须是相对路径；禁止 `..` 路径穿越、绝对路径和未经许可的 URL scheme。外部 URL 如未来开放，必须通过明确的 allowlist/配置启用。

## 4. Manifest 历史草案（已废弃）

> 本节以下旧示例保留用于解释早期设计来源，但已经被 `MANIFEST_SPEC_V1.md`、`MANIFEST_SCHEMA_V1.json` 和 ADR-011 取代，不得用于 Builder 或 Runtime 实现。冻结 V1 使用 `format = weisql`、`tables[].file` 和 `vectorCollections[]`。

以下是设计示例，不代表当前 SDK 已支持该格式。字段在实现前需通过 schema 校验和版本策略锁定。

```json
{
  "format": "weisql-ai",
  "formatVersion": "1.0.0",
  "datasetId": "example-docs",
  "createdAt": "2026-10-30T00:00:00Z",
  "metadata": {
    "title": "Example dataset",
    "description": "Public read-only dataset"
  },
  "tables": [
    {
      "name": "records",
      "schema": [
        { "name": "id", "type": "utf8", "nullable": false },
        { "name": "title", "type": "utf8", "nullable": false },
        { "name": "category", "type": "utf8", "nullable": true }
      ],
      "primaryKey": ["id"],
      "files": [
        {
          "path": "records/part-00000.parquet",
          "format": "parquet",
          "rows": 1000,
          "bytes": 123456,
          "sha256": "REPLACE_WITH_REAL_SHA256"
        }
      ]
    }
  ],
  "vectors": [
    {
      "name": "content_embedding",
      "sourceTable": "records",
      "idColumn": "id",
      "dimension": 768,
      "elementType": "float32",
      "metric": "cosine",
      "normalization": "not-required-by-format",
      "files": [
        {
          "path": "vectors/part-00000.f32",
          "format": "f32-row-major",
          "rows": 1000,
          "bytes": 3072000,
          "sha256": "REPLACE_WITH_REAL_SHA256"
        }
      ],
      "index": {
        "engine": "usearch",
        "engineVersion": "UNVERIFIED",
        "path": "indexes/vector.index",
        "sha256": "REPLACE_WITH_REAL_SHA256"
      }
    }
  ],
  "features": {
    "sql": true,
    "vectorSearch": true,
    "fullTextSearch": false,
    "hybridSearch": false
  }
}
```

### 4.1 规范约束

- `format` 必须等于 `weisql-ai`。
- `formatVersion` 使用语义化版本；读取器应拒绝不支持的主版本。
- 所有 `path` 必须唯一、相对化并通过路径安全校验。
- `bytes` 是文件实际字节数；读取时应验证，不可仅信任 Manifest。
- `sha256` 必须是实际内容的 SHA-256 十六进制摘要；示例占位值不能用于生产。
- `rows`、`dimension`、`bytes` 必须是非负安全整数；向量维度必须大于 0。
- `idColumn` 必须映射到源表主键或唯一标识；不允许依赖文件行顺序建立跨分片 ID 对应关系。
- 对向量记录，应明确向量行与业务 ID 的映射策略。首选显式 ID 映射文件或稳定的键映射，不能仅凭行号假设不同文件始终对齐。
- 可选功能应显式声明；缺少索引时，读取器可按策略退化为精确搜索或返回 `INDEX_NOT_FOUND`，行为需由 API 选项控制。

## 5. 向量语义

### 5.1 数据布局

基准格式先使用 little-endian Float32、row-major 连续布局：

`vector_bytes = row_count × dimension × 4`

例如 1000 条、768 维的向量原始数据为 3,072,000 bytes（不含索引与元数据）。该布局是基准测试格式，是否作为长期公开格式需在端序、对齐、分块加载与压缩测试后确定。

### 5.2 距离定义

- `cosine`：距离定义为 `1 - cosine_similarity`，越小越相似。
- `l2`：平方欧氏距离或欧氏距离必须明确选定，不能在不同后端间混用。
- `ip`：内积通常是越大越相似；SDK 应将其转换为统一排序语义或在类型中明确方向。
- 零向量的余弦距离行为必须统一定义；建议默认拒绝零向量并在构建阶段报告错误。
- 对 NaN、Infinity、维度不匹配，应返回明确错误，不得静默排序。

### 5.3 ANN 与过滤

先实现精确搜索作为正确性基线，再验证 HNSW/ANN。初始实验参数可从 `M=16`、`efConstruction=200`、`efSearch=64`、`topK=10` 开始，但这些只是实验起点，不是最终默认值。

过滤策略：

1. ANN-then-filter：先检索较大的候选集再过滤；可能返回少于 K 条。
2. Filter-first：先由 SQL 选出候选 ID，再在候选集内精确搜索；适用于候选集较小的场景。
3. 后续可按候选集大小、过滤选择率与测得延迟实现自适应策略。

结果应包含 `id`、`distance`、可选 `metadata` 和 `backend` 诊断信息。相同距离的稳定排序规则需定义（例如按规范化 ID 进行 tie-break）。

## 6. `.wsql` 单文件容器

### 6.1 设计原则

- 首阶段先保证多文件格式可用，避免过早冻结容器二进制协议。
- 单文件容器必须支持完整性校验、格式版本、文件目录和安全的路径解析。
- 如果目标是按需读取，容器必须能从尾部或固定位置快速找到目录，并支持 HTTP Range；否则浏览器可能需要下载整个文件。
- 需实测 CDN 是否保留 Range 行为、是否正确返回 `206 Partial Content`、`Content-Range`、ETag 与缓存头。
- 不应将压缩作为默认前提：压缩可能降低体积，却破坏随机访问或增加解压峰值内存。

### 6.2 候选容器结构（未冻结）

```text
[Header: magic + version + flags]
[Payload region: packed data files]
[Directory: path, offset, length, checksum, codec]
[Footer: directory offset/length + container checksum]
```

待验证点：整数宽度和端序、对齐、目录编码、校验算法、压缩块粒度、损坏恢复、Range 请求最小次数、是否允许重复路径，以及签名/可信来源策略。只有原型验证证明必要时才冻结此结构。

## 7. TypeScript SDK 草案

以下是目标 API 草案，不代表已实现或已发布 npm 包。

```ts
const db = await WeiSQL.open({
  manifestUrl: "/data/manifest.json",
  mode: "readonly",
});

const rows = await db.sql(
  "SELECT id, title FROM records WHERE category = ? LIMIT ?",
  ["biology", 10],
);

const hits = await db.vector.search("content_embedding", queryVector, {
  topK: 10,
  filter: { category: "biology" },
});

await db.close();
```

### 7.1 API 设计要求

- 优先参数化 SQL；不将用户输入直接拼接进 SQL 字符串。
- `open()` 支持 `manifestUrl` 和后续的本地 `File/ArrayBuffer` 数据源适配。
- 返回 Promise；长任务支持 `AbortSignal`（需验证后端能否真正中止）。
- 提供 `close()`，释放 DuckDB connection、Worker、WASM 资源与索引内存。
- 将错误归一化为稳定错误码，例如 `MANIFEST_INVALID`、`UNSUPPORTED_FORMAT_VERSION`、`FILE_INTEGRITY_MISMATCH`、`SQL_EXECUTION_FAILED`、`VECTOR_DIMENSION_MISMATCH`、`INDEX_NOT_FOUND`、`RESOURCE_LIMIT`。
- 浏览器与 Node.js 适配器可有不同能力；通过 `capabilities()` 显式报告，不能伪装成完全一致。

## 8. 全文与混合搜索

全文检索引擎尚未锁定。选型时需比较：浏览器/WASM 可用性、索引持久化、Unicode 与中文分词、内存、许可、索引构建时间和增量更新能力。

混合搜索初版使用候选集合并集与 Reciprocal Rank Fusion（RRF），避免直接相加不同量纲的 BM25 分数和向量距离：

`RRF(d) = Σ 1 / (k + rank_i(d))`

`k` 是可配置的排名平滑常数；需要通过基准和相关性数据验证默认值。V1 可先实现接口与测试，再在全文引擎确定后接入。

## 9. 安全与隐私

- 静态发布的数据默认是公开可下载的；不得把访问控制秘密、私密业务数据或服务端 API Key 放入数据包。
- 验证文件路径、Manifest 大小、文件长度、向量维度和分片数量，防止恶意元数据造成资源耗尽。
- 对外部 URL、跨域读取和重定向设限；浏览器读取依赖站点 CORS 配置。
- SQL 只读模式必须在 API 层和引擎层都限制写操作，不能只靠文档约定。
- 文件摘要用于完整性检测，不等同于来源真实性；需要防篡改时另行设计签名和可信密钥分发。
- 日志默认不输出完整查询文本、嵌入向量或用户敏感内容。

## 10. 测试与验收

### 10.1 阶段门槛

1. **格式单测**：Manifest schema、路径安全、版本兼容、摘要校验、损坏文件与边界值。
2. **精确搜索基线**：小型人工数据集校验 Top-K、距离定义、零向量与 tie-break。
3. **规模测试**：从 100k 向量开始，再扩展到 500k 和 1M；记录维度与硬件/浏览器环境。
4. **ANN 对比**：对照精确结果计算 Recall@K，并记录构建时间、查询 P50/P95、索引大小、峰值内存。
5. **运行时一致性**：同一测试向量集在 Node.js 与浏览器中比较 ID、排序和容差范围内的距离。
6. **静态部署**：验证 HTTPS、CORS、缓存头、Range、冷启动、离线/网络失败错误处理。
7. **资源释放**：反复 open/query/close，检查 Worker 与 WASM 资源是否泄漏。

### 10.2 报告必须记录

- CPU、内存、操作系统、Node.js/浏览器版本、WASM 版本。
- 数据规模、维度、距离度量、索引参数、随机种子。
- 构建与加载时间、P50/P95 延迟、Recall@K、索引字节数、峰值内存。
- 冷缓存与热缓存结果分别报告。
- 原始向量字节数与索引体积分开报告。
- 每个结果标记为“实测”“推算”或“待验证”。

## 11. 主要风险与未决事项

| 项目 | 当前状态 | 下一步验证 |
|---|---|---|
| DuckDB-Wasm 对所需 Parquet 查询的支持 | 待原型验证 | 浏览器读取、过滤、内存与 Worker 行为 |
| DuckDB Node.js API 的打包方式 | 待原型验证 | Node 版本、平台与发布产物 |
| USearch 在 WASM 与 Node.js 的可行集成 | 候选，不是已确认 | 官方绑定、序列化、许可证、过滤能力与构建链 |
| 索引文件跨运行时可移植性 | 未确认 | 相同索引能否跨平台加载；否则需要重建或分别构建 |
| 中文全文检索方案 | 未选定 | 分词、索引体积、WASM 与许可证比较 |
| `.wsql` 随机访问 | 设计阶段 | Range 原型、目录结构和压缩策略 |
| 百万向量性能 | 未测量 | 先跑 100k 基准，之后逐步扩容 |
| 浏览器写入/事务 | 不在 V1 核心范围 | 单独定义持久化与一致性模型 |

## 12. 当前实施顺序

1. 建立仓库骨架与文档版本管理。
2. 定义 Manifest JSON Schema 和测试样例。
3. 建立 Rust 精确余弦搜索基线，先不引入 ANN 依赖。
4. 对 USearch 与 DuckDB 进行最小集成验证。
5. 选择全文检索引擎并实现 RRF 测试。
6. 建立 TypeScript SDK 的最小只读 API。
7. 完成浏览器静态部署验证后，再冻结 `.wsql` 容器格式。

---

**重要说明：** 本文是工程设计草案，包含建议格式和目标 API。除非有明确测试报告支持，否则不应将这些内容表述为已实现能力、已验证兼容性或性能承诺。
