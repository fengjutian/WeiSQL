---
title: RAG 证据组装
description: 用 rag.search() 在字符预算内返回带名次与来源的证据片段，理解截断边界、文档来源和“不调用模型”的职责边界。
sidebar_position: 24
---

本页讲 `db.rag.search()`：它把向量与全文的融合结果转成受字符预算约束的证据片段。读完后你能正确设置预算、判断片段是否被截断，并明确它不会替你调用模型或拼 prompt。

## 最小示例

```ts
const result = await db.rag.search({
  text: { name: "documents_text", query: "dna" },
  vector: { name: "document_embeddings", query: [1, 0] },
  topK: 5,
  maxCharacters: 4000,
});

console.log(result.usedCharacters, result.truncated, result.droppedHits);
for (const evidence of result.evidences) {
  console.log(evidence.rank, evidence.id, evidence.characters, evidence.boundary);
  console.log(evidence.text);
}
```

只有文本来源也可以：

```ts
const result = await db.rag.search({
  text: { name: "documents_text", query: "细胞" },
});
```

## RagSearchOptions

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `text` | `{ name, query, topK? }` | 无 | **必填**；证据正文只来自文本索引 |
| `vector` | `{ name, query, topK? }` | 无 | 可选；提供时参与 RRF 融合 |
| `topK` | `number` | `5` | 融合后最多考虑的证据条数 |
| `k` | `number` | `60` | RRF 常数 |
| `maxCharacters` | `number` | `4000` | 证据总字符预算 |
| `signal` | `AbortSignal` | 无 | 取消查询 |

`topK`、`maxCharacters` 必须是正安全整数，`k` 必须是正有限数，否则 `INVALID_ARGUMENT`。

## RagResult

| 字段 | 含义 |
| --- | --- |
| `evidences` | 证据数组，按融合名次顺序 |
| `usedCharacters` | 已用字符数，所有片段长度之和 |
| `truncated` | 是否有任一片段被截断 |
| `droppedHits` | 被丢弃的融合命中数：没有正文，或预算已耗尽 |
| `diagnostics` | `{ backend: "rrf", k, maxCharacters, elapsedMs? }` |

每条 `RagEvidence`：

| 字段 | 含义 |
| --- | --- |
| `id` | 业务 ID |
| `text` | 证据正文（可能被截断） |
| `rank` | 在融合结果中的 1-based 位置 |
| `characters` | 该片段的字符数 |
| `truncated` | 该片段是否被截断 |
| `boundary` | 切点类型：`"none"`、`"sentence"`、`"word"`、`"character"` |
| `ranks` | 每个来源的 1-based 名次 |

`rank` 取融合位置，不重新编号。前面的命中因缺正文被丢弃时，后面的证据会出现名次跳号，这是刻意的：让调用方能回指原始排序。

## 文本来自哪里

`rag.search()` 不读 Parquet，正文来自文本索引里可选的 `documents` 文件：

- Manifest 的 `textIndexes[].documents` 必须存在，否则 `INVALID_ARGUMENT`，提示用当前 Builder 重新生成索引。
- 只有向量来源、没有文本行的命中会被计入 `droppedHits`；有文本行但正文读取失败的记录按完整性错误处理。
- 每条文档按行读取，校验偏移、UTF-8 与 JSON 形状；损坏抛 `RESOURCE_INTEGRITY_FAILED`。
- 正文是整行文档，不是分块；长文档会被预算截断，不做段落切分或重叠窗口。

`capabilities().ragSearch` 只有在“有 Reader 且至少一个文本索引声明了 `documents`”时才为 true。

## 预算与截断

每个片段拿剩余预算 `remaining = maxCharacters - usedCharacters` 去切：

1. 文本长度不超过预算：原样返回，`truncated: false`，`boundary: "none"`；
2. 否则在预算窗口内找最后一个句末标点（`.`、`!`、`?`、`。`、`！`、`？`、换行），切点保留标点，并吞掉紧跟的收尾引号或括号；
3. 没有可用句末时找最后一个空白，切在空白前；
4. 都没有就硬切到预算位置，`boundary: "character"`。

句末或词边界只有在保留至少一半预算时才被接受，否则宁可硬切，避免片段几乎为空。

字符按 JavaScript 字符串长度计算：常见 CJK 字符算 1，emoji 等增补平面字符算 2。预算不是字节数。

预算耗尽后，剩余融合命中全部计入 `droppedHits`。注意正文是在截断之前按融合行号批量预读的，因此这些被丢弃的行可能已经发生过读取。

## 组装流程

```text
校验参数
  → 找到 text 索引并确认声明了 documents
  → hybrid.search(topK, k, text, vector?)
  → 取融合命中里的 text.row，批量读取文档正文
  → 按融合顺序、剩余预算逐条截断
  → 返回 evidences 与统计
```

读取正文时只请求需要的行：先读偏移窗口，再逐条读取 JSONL 记录并校验行号、UTF-8 与 JSON 形状。

## 预算计算示例

假设 `maxCharacters` 为 200，融合后有 3 条命中，正文长度分别是 120、150、40：

| 步骤 | 剩余预算 | 结果 |
| --- | --- | --- |
| 第 1 条 | 200 | 完整返回，用掉 120 |
| 第 2 条 | 80 | 截断到 80，`boundary` 标出切点 |
| 第 3 条 | 0 | 计入 `droppedHits`，不读正文 |

最终 `usedCharacters` 为 200，`truncated` 为 true，`droppedHits` 为 1。缺正文的命中不消耗预算，后续条目仍可使用剩余额度，但它本身计入丢弃。

## 与 prompt 的衔接

SDK 只交付证据，prompt 由调用方拼装。保留 `id` 与 `rank` 才能在答案里标注来源：

```ts
const context = result.evidences
  .map(item => `[${item.rank}] (${item.id}) ${item.text}`)
  .join("\n\n");

const messages = [
  { role: "system", content: "只根据给定资料回答，并标注来源编号。" },
  { role: "user", content: `资料：\n${context}\n\n问题：DNA 的结构是什么？` },
];
```

这段代码不调用模型；模型选择、重试与引用格式都由应用决定。

## 行为与职责边界

- 不调用模型、不拼 prompt、不做摘要或重排；只返回证据与来源。
- 不做引用编号、不生成答案、不判断证据是否足够回答。
- 融合沿用 `hybrid.search()` 的 RRF 语义：`score` 不暴露给证据，只给名次；原始向量距离与 BM25 分数也不随证据返回。
- 证据顺序就是融合顺序，调用方可以自行再排序，但 `rank` 仍表示原位置。
- 预取消或中途取消抛 `QUERY_CANCELLED`；数据库关闭后抛 `DATABASE_CLOSED`。

## 常见错误

| 错误码 | 场景 |
| --- | --- |
| `INVALID_ARGUMENT` | 缺少 `text`；`topK`、`maxCharacters`、`k` 非法；索引未声明 `documents` |
| `INDEX_NOT_FOUND` | 文本索引或向量集合不存在；没有 Reader |
| `RESOURCE_INTEGRITY_FAILED` | 文档偏移、UTF-8、JSON 或行号不一致 |
| `QUERY_CANCELLED` | 读取证据过程中被取消 |
| `DATABASE_CLOSED` | 数据库已关闭 |

## 行为边界

- 只支持单列文本索引；没有分块、父子文档或跨文档去重。
- 预算按字符而不是 token 计算，不能直接换算成模型上下文长度。
- 端到端实测只覆盖 3 篇文档的 fixture；长文档截断质量与真实语料上的证据充分性未验证。
- 文档正文进入静态数据包即视为可公开下载；不要打包私密内容或密钥。
- 索引里的 `documents` 是可选字段，旧包可能没有；升级后需要重新生成索引。

## 延伸阅读

- [全文检索设计](https://github.com/fengjutian/WeiSQL/blob/main/docs/FULL_TEXT_SEARCH.md)
- [SDK API 契约](https://github.com/fengjutian/WeiSQL/blob/main/docs/SDK_API_CONTRACT_V1.md)
