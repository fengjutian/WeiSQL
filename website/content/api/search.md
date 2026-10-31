---
title: 检索 API
description: db.vector.search、db.text.search、db.hybrid.search 与 db.rag.search 的完整签名、选项默认值、过滤写法、返回字段与诊断信息。
sidebar_position: 73
hero:
  kicker: "API · 检索"
  title: "四个检索入口的签名"
  lead: "向量、全文、混合与 RAG 的选项、默认值与诊断。"
  chips: ["vector", "text", "hybrid", "rag"]
hide_title: true
---


本页是四类检索入口的参考：签名、选项、默认值、返回值与诊断字段。行为细节与取舍见对应的使用指南；这里只写契约与边界。

| 入口 | 返回 | 必需前置 |
| --- | --- | --- |
| `db.vector.search()` | `Promise<readonly VectorHit[]>` | `resourceReader`；带 `filter` 时还需 `sqlAdapter` |
| `db.text.search()` | `Promise<readonly TextHit[]>` | `resourceReader`，且 Manifest 声明 `textIndexes` |
| `db.hybrid.search()` | `Promise<readonly HybridFusionHit[]>` | 至少一个来源 |
| `db.rag.search()` | `Promise<RagResult>` | `text` 来源，且索引声明 `documents` |

## db.vector.search()

```ts
search(
  vectorName: string,
  queryVector: Float32Array | readonly number[],
  options?: VectorSearchOptions,
): Promise<readonly VectorHit[]>;
```

`queryVector` 会统一转换为 `Float32Array`；长度必须等于集合的 `dimension`，否则 `VECTOR_DIMENSION_MISMATCH`（`details.expected` / `details.actual`）。

### VectorSearchOptions

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `topK` | `number` | `10` | 正安全整数；内置精确扫描上限 100000 |
| `filter` | `FilterExpression` | 无 | 对已声明列的 AND 条件 |
| `strategy` | `"exact-filter-first" \| "vector-first"` | `"exact-filter-first"` | 只在提供 `filter` 时允许 |
| `vectorFirst` | `VectorFirstOptions` | 无 | 仅 `vector-first` 使用 |
| `signal` | `AbortSignal` | 无 | 取消查询 |

`VectorFirstOptions`：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `initialCandidates` | `number` | `topK × 4` | 首轮候选窗口 |
| `expansionStep` | `number` | `topK × 4` | 每轮扩张步长 |
| `maxCandidates` | `number` | `10000` | 候选窗口硬上限，必须 ≥ `topK` |

实际候选上限为 `min(maxCandidates, max(集合行数, topK))`；`maxCandidates < topK`、非正或非安全整数均返回 `INVALID_ARGUMENT`。

### 输入校验

- 未注入 `resourceReader`：`INDEX_NOT_FOUND`。
- `vectorName` 不在 `vectorCollections` 中：`INDEX_NOT_FOUND`。
- 维度不匹配：`VECTOR_DIMENSION_MISMATCH`。
- `topK` 非正或非安全整数、向量含非有限值、`cosine` 度量下传入全零向量：`VECTOR_INVALID_VALUE`。
- 只给 `strategy` 不给 `filter`：`INVALID_ARGUMENT`（`details.strategy`）。
- 给了 `filter` 但没有 `sqlAdapter`：`SQL_UNSUPPORTED`。

## 过滤表达式

`FilterExpression` 是 `Readonly<Record<string, FilterCondition>>`，键是 Manifest 已声明的列名，多个键按 AND 组合。

| 写法 | 编译结果 | 说明 |
| --- | --- | --- |
| `{ category: "genetics" }` | `"category" = ?` | 标量等值 |
| `{ category: null }` | `"category" IS NULL` | `null` 表示空值判断 |
| `{ category: ["a", "b"] }` | `"category" IN (?, ?)` | 数组成员，至少 1 个 |
| `{ category: { in: ["a"] } }` | `"category" IN (?)` | 显式成员形式 |
| `{ score: { gte: 0.5, lt: 0.9 } }` | `"score" >= ? AND "score" < ?` | 范围，至少 1 个边界 |
| `{ category: { ne: "a" } }` | `"category" <> ?` | 不等 |

限制：

- 列名必须在 Manifest 中声明，否则 `INVALID_ARGUMENT`（`details.table` / `details.column`）；列名取自白名单并加引号，值全部参数绑定。
- 成员条件上限 1000 个值，空数组、含 `null`、`null` 成员均报 `INVALID_ARGUMENT`。
- `{ in }` 与 `{ ne }` 不能与其他操作符混写；`ne` 不接受 `null`。
- 范围只接受 `gte`/`gt`/`lte`/`lt`；不能同时给 `gte` 与 `gt`、`lte` 与 `lt`；边界不能为 `null`；不支持 `{ not }`、`{ or }`、嵌套表达式。
- `date` / `timestamp` 列接受 `Date` 或字符串：`date` 字符串必须是 `YYYY-MM-DD`，`timestamp` 字符串必须能被解析；`Date` 只在 `date`/`timestamp` 列上合法，`Invalid Date` 报 `INVALID_ARGUMENT`。
- 整型列只接受 `Number.isSafeInteger` 的值，浮点列只接受有限数，`boolean` 列只接受布尔值，`string` 列只接受字符串。
- `json` 列一律拒绝等值过滤（`details.supported` 与 `details.hint` 会提示）。JSON 相等需要规范化形式，猜测会静默匹配不到；需要 JSON 谓词时用 `db.sql()` 的 `json_extract`。

```ts
const hits = await db.vector.search("document_embeddings", [1, 0], {
  topK: 5,
  filter: {
    category: "genetics",
    title: ["DNA", "RNA"],
    score: { gte: 0.5, lt: 0.9 },
    published: { gte: new Date("2026-01-01") },
  },
});
```

## 两种策略

`exact-filter-first`（默认）：先用一条参数化 SQL 求出满足过滤的完整业务 ID 集合，再映射为向量行，最后只在这些行上做精确距离比较。结果仍是过滤子集上的严格最近 K，因此 `exact` 恒为 `true`。代价是一次 SQL 加一次业务 ID → 行映射（有 `idIndex` 时二分，否则整份 ID Map 扫描）。

`vector-first`：先取有界候选窗口做精确扫描，再用 SQL 过滤命中。窗口按 `expansionStep` 扩张，直到凑够 `topK` 或触顶。它只省掉 ID 映射，不省向量扫描；结果只是“窗口内最近的 K”，只有窗口覆盖整个集合时才 `exact: true`。

`vector-first` 只在内置精确管线上可用；注入 `VectorAdapter` 后传 `strategy: "vector-first"` 返回 `SQL_UNSUPPORTED`。

### 诊断字段

`diagnostics` 由当前管线填写，字段可能缺失：

| 字段 | 出现场景 | 含义 |
| --- | --- | --- |
| `backend` | 总是 | `"typescript-exact"`、`"typescript-exact+sql-filter"` |
| `exact` | 总是 | 结果是否可声明为精确 |
| `strategy` | 带 `filter` | 实际使用的策略 |
| `filteredCandidates` | 带 `filter` | 通过过滤的候选数（exact-filter-first 为允许行数） |
| `candidatesScanned` | `vector-first` | 实际检查的候选窗口大小 |
| `candidateCap` | `vector-first` | 窗口硬上限 |
| `elapsedMs` | 内置管线 | 查询耗时 |

## VectorHit

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `row` | `number` | 集合内行号，0 起 |
| `id` | `string \| number` | 业务 ID，保留原始类型 |
| `distance` | `number` | 距离，越小越相似 |
| `metadata` | `Record<string, unknown>`（可选） | 预留；内置管线不填充 |
| `diagnostics` | 见上表（可选） | 仅内置管线保证 |

三种度量（`cosine`、`l2`、`ip`）都归一为“越小越好”，调用方不需要切换排序方向。

## db.text.search()

```ts
search(indexName: string, query: string, options?: TextSearchOptions): Promise<readonly TextHit[]>;
```

`TextSearchOptions.topK` 在类型上必填，但 Runtime 会用 `options?.topK ?? 10`，因此省略等价于 `10`。`topK` 必须是正安全整数且不超过 1000，否则 `INVALID_ARGUMENT`（`details.limit`）。

```ts
const hits = await db.text.search("documents_text", "dna", { topK: 5 });
// [{ row: 0, id: "doc-001", score: 1.023, diagnostics: { backend: "text-bm25" } }]
```

### TextHit

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `row` | `number` | 表内行号 |
| `id` | `string \| number` | 业务 ID |
| `score` | `number` | BM25 分数，**越大越相关**，与 `distance` 方向相反 |
| `diagnostics.backend` | `string` | 固定 `"text-bm25"` |

BM25 方向要点：只返回 `score > 0` 的文档；同分按 `row` 升序；查询词项先去重，分词结果为空时直接返回 `[]` 且不读索引。`k1` 默认 1.2、`b` 默认 0.75，可被 Manifest 的 `textIndexes[]` 覆盖。`score` 无上界，不能与向量距离比较或相加。

## db.hybrid.search()

```ts
search(options: HybridSearchOptions): Promise<readonly HybridFusionHit[]>;
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `topK` | `number` | `10` | 融合结果条数，正安全整数 |
| `k` | `number` | `60` | RRF 常数，正有限数 |
| `vector` | `HybridVectorSource` | 无 | `{ name, query, topK? }` |
| `text` | `HybridTextSource` | 无 | `{ name, query, topK? }` |
| `signal` | `AbortSignal` | 无 | 取消查询 |

`vector` 与 `text` 都不给时返回 `INVALID_ARGUMENT`。每个来源的默认取数为 `max(topK × 4, topK)`，即 `topK × 4`；可被来源自己的 `topK` 覆盖。两个来源都返回空时融合结果为空数组。

```ts
const fused = await db.hybrid.search({
  topK: 10,
  k: 60,
  vector: { name: "document_embeddings", query: [1, 0], topK: 20 },
  text: { name: "documents_text", query: "dna", topK: 20 },
});
```

### HybridFusionHit

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string \| number` | 业务 ID，按类型区分 `1` 与 `"1"` |
| `score` | `number` | RRF 分数 `Σ 1 / (k + rank)`，越大越好；不可与 BM25 或距离比较 |
| `ranks` | `Record<string, number>` | 各来源的 1 基名次，键为 `"vector"` / `"text"` |
| `vector` | `{ row, distance }`（可选） | 该 ID 的向量侧原始结果 |
| `text` | `{ row, score }`（可选） | 该 ID 的文本侧原始结果 |
| `diagnostics` | `{ backend: "rrf", k, elapsedMs? }` | 融合诊断 |

`ranks` 只包含实际返回该 ID 的来源：只被文本召回时没有 `"vector"` 键。排序先按 `score`，再按最好名次，最后按插入顺序，结果确定。`hybrid.search()` 不接受 `filter`。

## db.rag.search()

```ts
search(options: RagSearchOptions): Promise<RagResult>;
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `topK` | `number` | `5` | 融合候选数，正安全整数 |
| `k` | `number` | `60` | RRF 常数，正有限数 |
| `maxCharacters` | `number` | `4000` | 证据总字符预算，正安全整数 |
| `vector` | `HybridVectorSource` | 无 | 可选向量来源 |
| `text` | `HybridTextSource` | **必填** | RAG 需要正文，只有文本索引携带 |
| `signal` | `AbortSignal` | 无 | 取消查询 |

缺少 `text`、`topK`/`maxCharacters` 非法、`k` 非法均返回 `INVALID_ARGUMENT`；索引不存在返回 `INDEX_NOT_FOUND`；索引未声明 `documents` 返回 `INVALID_ARGUMENT`（提示用当前 Builder 重建）。

WeiSQL 不调用模型、不拼 prompt、不做摘要：只返回带名次与来源的预算内证据，prompt 与引用由调用方负责。

### RagResult

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `evidences` | `readonly RagEvidence[]` | 按融合名次排列 |
| `usedCharacters` | `number` | 所有片段字符数之和 |
| `truncated` | `boolean` | 是否存在被截断的片段 |
| `droppedHits` | `number` | 被丢弃的融合命中：没有正文，或预算已耗尽 |
| `diagnostics` | `{ backend: "rrf", k, maxCharacters, elapsedMs? }` | 预算与融合参数 |

### RagEvidence

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | `string \| number` | 业务 ID |
| `text` | `string` | 片段正文，最长到剩余预算 |
| `rank` | `number` | 在融合排序中的 1 基位置；有丢弃时会出现空号 |
| `characters` | `number` | 片段字符数，等于 `text.length` |
| `truncated` | `boolean` | 该片段是否被切过 |
| `boundary` | `"none" \| "sentence" \| "word" \| "character"` | 切点类型 |
| `ranks` | `Record<string, number>` | 沿用融合名次 |

`boundary` 的取值：文本未超预算为 `none`；切在句末标点（`.`、`!`、`?`、`。`、`！`、`？`、换行，连同紧跟的闭引号/闭括号）为 `sentence`；切在空白处为 `word`；都不满足时硬切为 `character`。句或词的切点必须保留至少一半预算，否则改为硬切。

```ts
const result = await db.rag.search({
  topK: 3,
  maxCharacters: 1200,
  text: { name: "documents_text", query: "dna" },
});

for (const evidence of result.evidences) {
  console.log(evidence.rank, evidence.boundary, evidence.truncated, evidence.text);
}
console.log(result.usedCharacters, result.droppedHits);
```

## 错误码

| 错误码 | 触发场景 |
| --- | --- |
| `INDEX_NOT_FOUND` | 集合/索引名未声明；未注入 `resourceReader` |
| `VECTOR_DIMENSION_MISMATCH` | 查询向量维度不等于 `dimension` |
| `VECTOR_INVALID_VALUE` | `topK` 非法；向量含非有限值；`cosine` 下全零查询向量 |
| `INVALID_ARGUMENT` | 过滤条件非法；`strategy` 无 `filter`；`topK > 100000`；文本 `topK > 1000`；hybrid 无来源；RAG 缺 `text` 或索引无 `documents`；`k`/`maxCharacters` 非法 |
| `SQL_UNSUPPORTED` | 有 `filter` 但未注入 `sqlAdapter`；`vector-first` 用在 Adapter 管线；Adapter 不具备过滤能力 |
| `QUERY_CANCELLED` | `signal` 已中止 |
| `DATABASE_CLOSED` | Runtime 不在 `READY` 状态 |
| `RESOURCE_INTEGRITY_FAILED` | 索引内容损坏；业务 ID 超出安全整数范围 |
| `INTERNAL_ERROR` | Adapter 返回了过滤集合之外的行（契约被破坏） |

注入 `VectorAdapter` 时，`VectorHit` 由 Adapter 返回，`diagnostics` 字段与内置管线不保证一致；Runtime 仍负责校验与过滤集合解析。

## 延伸阅读

- [向量检索](/docs/sdk/vector-search)：距离语义、过滤成本与策略取舍。
- [全文检索与混合检索](/docs/sdk/text-and-hybrid)：分词、BM25 与 RRF 的完整说明。
- [RAG 证据组装](/docs/sdk/rag)：预算分配与截断示例。
- [错误码](/docs/sdk/errors)：`WeiSQLError` 的结构与恢复建议。
