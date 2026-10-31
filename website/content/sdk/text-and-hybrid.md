---
title: 全文检索与混合检索
description: 使用 text.search() 做 BM25 关键词检索，再用 hybrid.search() 按 RRF 融合向量与文本结果，并正确解读两路名次与原始分数。
sidebar_position: 23
hero:
  kicker: "SDK · 检索"
  title: "BM25 与 RRF 融合"
  lead: "全文检索按词打分，融合只使用名次；两类分数不能直接比较。"
  chips: ["BM25", "CJK", "RRF", "k=60"]
hide_title: true
examples: [node, browser]
---


本页讲全文检索和 RRF 融合检索：`text.search()` 如何用 BM25 排序，`hybrid.search()` 如何按名次而不是分数融合两路结果。读完后你能读懂 `score` 的方向、`ranks` 的含义，并知道哪些比较是不成立的。

## 最小示例

全文检索：

```ts
const hits = await db.text.search("documents_text", "dna", { topK: 5 });
// [{ row: 0, id: "doc-001", score: 1.023, diagnostics: { backend: "text-bm25" } }]
```

混合检索：

```ts
const fused = await db.hybrid.search({
  topK: 10,
  k: 60,
  vector: { name: "document_embeddings", query: [1, 0], topK: 20 },
  text: { name: "documents_text", query: "dna", topK: 20 },
});

for (const hit of fused) {
  console.log(hit.id, hit.score, hit.ranks, hit.vector?.distance, hit.text?.score);
}
```

## text.search() 选项

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `topK` | `number` | `10` | 正安全整数，且不超过 1000 |
| `signal` | `AbortSignal` | 无 | 取消查询 |

`TextHit` 字段：`row`、`id`、`score`、可选的 `diagnostics`（`backend: "text-bm25"`、`elapsedMs`）。

前置条件：

- Manifest 必须声明同名的 `textIndexes` 条目，否则 `INDEX_NOT_FOUND`。
- 必须注入 `resourceReader`，否则 `INDEX_NOT_FOUND`。
- 一个文本索引只绑定一张表的一个文本列；跨字段加权、短语、前缀、通配、同义词、拼写纠错都不支持。

## 文本索引的声明

`textIndexes[]` 的关键字段：

| 字段 | 含义 |
| --- | --- |
| `name` | 索引名，传给 `text.search()` |
| `tableName` / `column` | 绑定表与文本列（`string` 或 `json`） |
| `idColumn` | 业务 ID 列，必须是该表主键 |
| `documentCount` | 文档数，等于表行数 |
| `termCount` | 词项数 |
| `averageDocumentLength` | 平均文档长度，BM25 使用声明值 |
| `data` / `termOffsets` | 排序后的词项 JSONL 与 UInt64 偏移 |
| `docLengths` | 每文档词项数的 UInt32 数组 |
| `idMap` | 行到业务 ID 的映射 |
| `documents` | 可选，行到原始文本，RAG 需要 |
| `k1` / `b` | 可选，覆盖 BM25 默认参数 |

`documentCount`、`termCount`、`averageDocumentLength` 都必须在 Manifest 中声明，运行时不会为了重算它们而扫描全库。

## 分词规则

查询和索引使用同一个 `tokenize()`：

1. Unicode NFC 归一化，再转小写；
2. 按“字母或数字”切分，其余字符都是分隔符；
3. 汉字、平假名、片假名、谚文逐字符成为独立词项；
4. 默认不丢弃短词（`minLength = 1`）。

因此中文按字匹配：`细胞` 会拆成两个单字词项，召回高但精度低。英文不做词干化，`running` 与 `ran` 不互相匹配。没有停用词表。

查询词项会去重；分词结果为空时直接返回 `[]`，不读索引。

## BM25 评分

```text
idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5))
score  = Σ idf(t) · tf·(k1+1) / (tf + k1·(1 - b + b·dl/avgdl))
```

| 参数 | 默认 | 来源 |
| --- | --- | --- |
| `k1` | `1.2` | Manifest 的 `textIndexes[].k1` 可覆盖 |
| `b` | `0.75` | Manifest 的 `textIndexes[].b` 可覆盖 |
| `N` | `documentCount` | Manifest 声明值，不在查询时重算 |
| `avgdl` | `averageDocumentLength` | Manifest 声明值 |

`score` 越大越相关，与 `VectorHit.distance` 的方向相反。这两类分数不能直接比较大小，也不能相加。

同分按 `row` 升序；只保留分数大于 0 的文档。`topK` 之外的候选不会返回。

## text.search() 的读取成本

- 每个查询词项做一次二分定位：`O(log termCount)` 次 Range 读取。
- 词项偏移文件整体读取一次（`termCount × 8` 字节）。
- 文档长度文件整体读取一次（`documentCount × 4` 字节）。100 万文档约 4 MB/查询，这是已记录的成本。
- 只对最终候选批量读取业务 ID。

索引内容是 JSONL 加 UInt64 偏移；损坏的 UTF-8、JSON、偏移或行号会抛 `RESOURCE_INTEGRITY_FAILED`，不会静默跳过。

## hybrid.search() 选项

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `topK` | `number` | `10` | 融合后返回条数 |
| `k` | `number` | `60` | RRF 常数，必须为正有限数 |
| `vector` | `{ name, query, topK? }` | 无 | 向量来源；`topK` 默认 `max(topK × 4, topK)` |
| `text` | `{ name, query, topK? }` | 无 | 文本来源；`topK` 默认同上 |
| `signal` | `AbortSignal` | 无 | 取消查询 |

`vector` 与 `text` 至少要提供一个，否则 `INVALID_ARGUMENT`。两路结果各自先取更多候选，让融合有对方列表之外的候选。

## RRF 融合语义

```text
score(d) = Σ 1 / (k + rank_i(d))
```

名次从 1 开始，只使用名次，不使用原始分数。这样做的原因是 BM25 分数无上界、向量距离又依赖度量，任何分数归一化都是任意的。

`HybridFusionHit` 字段：

| 字段 | 含义 |
| --- | --- |
| `id` | 业务 ID |
| `score` | 融合后的 RRF 分数，越大越好；不能与 BM25 或距离比较 |
| `ranks` | 每个贡献来源的 1-based 名次，键为 `"vector"` 与 `"text"` |
| `vector` | 命中时含 `row` 与 `distance` |
| `text` | 命中时含 `row` 与 `score` |
| `diagnostics` | `{ backend: "rrf", k, elapsedMs? }` |

行为要点：

- 只有一路有结果时，融合结果只含该路，`ranks` 也只有对应键。
- 两路都为空时返回 `[]`。
- 排序按分数降序；同分先比最佳单路名次，再按插入顺序，结果确定。
- 融合分数不是概率，也没有跨查询的可比性；不要把它当阈值。

## 常见错误

| 错误码 | 场景 |
| --- | --- |
| `INDEX_NOT_FOUND` | 文本索引或向量集合不存在；没有 Reader |
| `INVALID_ARGUMENT` | `topK` 非法（文本还有 1000 上限）；`k` 非正；两路都没提供 |
| `QUERY_CANCELLED` | 查询被取消 |
| `DATABASE_CLOSED` | 数据库已关闭 |
| `RESOURCE_INTEGRITY_FAILED` | 词项文件、文档长度、ID Map 内容损坏 |

向量路径自身的错误（维度、非有限值、过滤能力）会原样向上抛，不会因为走融合而被吞掉。

## 行为边界

- 全文检索只支持单列、单字段；没有中文分词器，CJK 逐字是刻意取舍。
- `text.search()` 的 `topK` 上限是 1000；`hybrid` 的来源 `topK` 没有同样的显式上限，但会受向量基线与文本读取器约束。
- 文本索引不参与 L3 之外的格式校验；`verifyChecksums: "all"` 只校验摘要与 ID Map 内容。
- 混合检索不调用模型、不做重排、不支持来源权重。
- 端到端实测只覆盖 3 篇文档的 fixture；长文本与大规模语料下的排序质量未验证。
- 真实 CDN 上的多文件 Range 延迟未验证。

## 延伸阅读

- [全文检索设计](https://github.com/fengjutian/WeiSQL/blob/main/docs/FULL_TEXT_SEARCH.md)
- [SDK API 契约](https://github.com/fengjutian/WeiSQL/blob/main/docs/SDK_API_CONTRACT_V1.md)
