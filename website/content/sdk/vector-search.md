---
title: 向量检索
description: 使用 vector.search() 做精确向量检索，理解距离方向、过滤表达式、两种混合策略与 exact 声明。
sidebar_position: 22
---

本页讲 `db.vector.search()` 的调用方式、距离语义、过滤 DSL 与两种混合策略。读完后你能判断一次查询是否真的是“过滤子集上的最近 K”，并知道哪些诊断字段能证明这一点。

## 最小示例

```ts
const hits = await db.vector.search("document_embeddings", [1, 0], { topK: 10 });

for (const hit of hits) {
  console.log(hit.row, hit.id, hit.distance, hit.diagnostics?.exact);
}
```

查询向量可以是普通数组或 `Float32Array`；内部会统一成 `Float32Array`。维度必须与 Manifest 声明一致。

带过滤的查询：

```ts
const hits = await db.vector.search("document_embeddings", [1, 0], {
  topK: 2,
  filter: { category: "genetics" },
});
// diagnostics: { backend: "typescript-exact+sql-filter", exact: true, strategy: "exact-filter-first" }
```

有界候选窗口：

```ts
const hits = await db.vector.search("document_embeddings", [1, 0], {
  topK: 2,
  filter: { category: "genetics" },
  strategy: "vector-first",
  vectorFirst: { initialCandidates: 2, expansionStep: 2, maxCandidates: 50 },
});
```

## VectorSearchOptions

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `topK` | `number` | `10` | 必须是正安全整数；内置精确管线上限 100000 |
| `filter` | `FilterExpression` | 无 | 对已声明列的等值、成员或范围条件，AND 组合 |
| `strategy` | `"exact-filter-first" \| "vector-first"` | `"exact-filter-first"` | 只在提供 `filter` 时允许 |
| `vectorFirst` | `VectorFirstOptions` | 无 | `initialCandidates`、`expansionStep`、`maxCandidates` |
| `signal` | `AbortSignal` | 无 | 取消查询 |

`VectorHit` 的字段是 `row`、`id`、`distance`、可选的 `metadata` 与 `diagnostics`。`diagnostics` 可能含 `backend`、`elapsedMs`、`exact`、`strategy`、`filteredCandidates`、`candidatesScanned`、`candidateCap`。

## 距离语义

向量文件编码为 `f32-le-row-major`，即 Float32 小端、按行优先。

| `metric` | 计算 | 方向 |
| --- | --- | --- |
| `cosine` | `1 - cosine_similarity` | 越小越相似，取值约 `[0, 2]` |
| `l2` | 欧氏距离 | 越小越相似，无上界 |
| `ip` | 负内积 | 越小越相似，无上界 |

三种度量都统一为“越小越好”，调用方不需要按度量切换排序方向。距离相同时按 `row` 升序，保证跨运行稳定。

## 输入校验

- 未注入 `resourceReader`：`INDEX_NOT_FOUND`。
- 集合名不在 Manifest 中：`INDEX_NOT_FOUND`。
- 查询维度不等于 `dimension`：`VECTOR_DIMENSION_MISMATCH`，`details` 含 `expected` 与 `actual`。
- 分量含 `NaN`/`Infinity`：`VECTOR_INVALID_VALUE`，`details.position` 给出位置。
- Cosine 查询向量全零：`VECTOR_INVALID_VALUE`（方向未定义）。
- `topK` 非正安全整数：`VECTOR_INVALID_VALUE`；超过 100000 时由精确基线抛 `INVALID_ARGUMENT`。
- 只传 `strategy` 不传 `filter`：`INVALID_ARGUMENT`。

## 过滤表达式

条件全部 AND 组合，字段必须在 Manifest 中声明，值按列类型校验并全部参数绑定。

| 写法 | 含义 |
| --- | --- |
| `{ category: "genetics" }` | 等值 |
| `{ category: null }` | `IS NULL` |
| `{ title: ["DNA", "RNA"] }` | `IN (...)`，至少一个值 |
| `{ title: { in: ["DNA"] } }` | `IN` 的显式写法 |
| `{ score: { gte: 0.5, lt: 0.9 } }` | 范围，至少一个边界 |
| `{ category: { ne: "other" } }` | 不等 |

边界规则：

- 成员条件最多 1000 个值，不接受 `null`（需要空值请单独写 `IS NULL`）。
- 范围不接受空条件，也不能同时给 `gt` 与 `gte`，或 `lt` 与 `lte`。
- `ne` 不接受 `null`。
- `date` / `timestamp` 接受 `Date` 或 ISO 字符串；`date` 的字符串必须是 `YYYY-MM-DD`，`Date` 只对这两类列合法。
- `json` 列的过滤明确拒绝：JSON 相等需要规范化形式，猜测会静默匹配不到。需要 JSON 谓词时用 `db.sql()` 的 `json_extract`。
- 未知列：`INVALID_ARGUMENT`。
- 值类型与列类型不符：`INVALID_ARGUMENT`。

过滤依赖 `sqlAdapter`。未注入时带 `filter` 的调用返回 `SQL_UNSUPPORTED`，而不是忽略条件。

## exact-filter-first（默认）

先用 SQL 求出满足条件的完整业务 ID 集合，再映射成向量行，最后只在这些行上做精确比较。

- 结果确实是“过滤子集上的严格最近 K”，因此诊断可以标 `exact: true`。
- 代价是一次 SQL 加一次完整 ID Map 扫描（没有持久化 `id → row` 索引时）。
- 若 Manifest 声明了 `idIndex`，过滤改用该索引二分查找，不再整份扫描。
- 允许行不超过集合的 1/8 时，按连续段合并读取向量；否则顺序扫描全量。
- 允许行为空时直接返回 `[]`，不读向量数据。
- 诊断字段：`strategy: "exact-filter-first"`、`filteredCandidates`、`exact: true`。

## vector-first

先取有界候选窗口，再用 SQL 过滤命中的候选。

| 选项 | 默认 | 约束 |
| --- | --- | --- |
| `initialCandidates` | `topK × 4` | 至少 `topK`，不超过候选上限 |
| `expansionStep` | `topK × 4` | 正安全整数 |
| `maxCandidates` | `10000` | 不小于 `topK`；最终上限为 `min(maxCandidates, max(count, topK))` |

窗口从 `initialCandidates` 起步，命中数不足 `topK` 时按 `expansionStep` 扩张，直到达到上限或覆盖候选数。

- “最近 K”只保证在已考虑窗口内；只有窗口覆盖整个集合时 `exact` 才为 `true`，靠穷尽而非构造。
- 命中数可能少于 `topK`，`diagnostics` 会给出实际窗口。
- 它省掉的是全量 ID Map 扫描，不是向量扫描：内置管线仍会完整过一遍向量。
- 诊断字段：`candidatesScanned`、`filteredCandidates`、`candidateCap`、`exact`。

## 读取路径与诊断

内置精确管线每次请求一个解码块，默认块大小 1024 行，只保留当前块与最多 `topK` 个候选；距离扫描结束后才为最终候选读取业务 ID。分块降低峰值内存，但不会减少总读取量或计算量。

诊断值可以直接用于判断结果性质：

| 场景 | `backend` | 关键字段 |
| --- | --- | --- |
| 无过滤精确搜索 | `typescript-exact` | `exact: true` |
| `exact-filter-first` | `typescript-exact+sql-filter` | `exact: true`、`strategy`、`filteredCandidates` |
| `vector-first` | `typescript-exact+sql-filter` | `exact` 视窗口而定、`candidatesScanned`、`candidateCap` |
| 注入的精确 Adapter | 由 Adapter 决定 | 必须声明 `exact: true` 才可当作精确 |
| ANN Adapter | 由 Adapter 决定 | 不得声明 `exact: true` |

`metadata` 是可选字段，内置管线不会填充它；需要业务字段时用 `id` 回表查询。`elapsedMs` 来自 `performance.now()`，只用于诊断，不是性能承诺。

## 注入 VectorAdapter 时

注入 `vectorAdapter` 后，Runtime 仍负责参数校验与过滤求解，Adapter 只接收 `vector`、`query`、`topK`、`allowedRows` 与 `signal`。

- 过滤要求 Adapter 声明 `exactSearch: true`，或显式声明 `postFiltering: true`（结果按构造不完整）。
- Adapter 返回了 `allowedRows` 之外的行时抛 `INTERNAL_ERROR`，不会静默扩大结果集。
- `vector-first` 只在内置精确管线可用；对 Adapter 使用抛 `SQL_UNSUPPORTED`。
- Adapter 的 `capabilities` 含 `engine`、`metrics`、`persistedIndex`、`metadataFiltering`、`postFiltering`、`exactSearch`、`cancellation`。
- ANN Adapter 必须声明 `exactSearch: false`；此时 `capabilities().vectorAnnSearch` 为 true，结果不得当作精确最近邻。

## 常见错误

| 错误码 | 场景 |
| --- | --- |
| `INDEX_NOT_FOUND` | 集合不存在，或没有注入 Reader |
| `VECTOR_DIMENSION_MISMATCH` | 查询维度与集合不一致 |
| `VECTOR_INVALID_VALUE` | 非有限值、Cosine 零向量、非法 `topK` |
| `INVALID_ARGUMENT` | `filter` 结构非法、字段未声明、策略缺过滤、`topK` 超出基线上限 |
| `SQL_UNSUPPORTED` | 有过滤但没有 SQL Adapter；Adapter 不支持所需过滤能力 |
| `QUERY_CANCELLED` | 查询被取消 |
| `DATABASE_CLOSED` | 数据库已关闭 |
| `RESOURCE_INTEGRITY_FAILED` | 向量块不完整、ID Map 与候选数不一致 |

## 行为边界

- 内置管线只有精确扫描，没有 ANN；分块降低峰值内存，不减少总读取量与计算量。
- 过滤每次都要付一次 SQL；V1 的 `idIndex` 由 Builder 生成，缺省时退化为整份 ID Map 扫描。
- `vector-first` 不保证过滤子集上的严格最近 K，不能对外声明精确。
- ANN 在真实数据集上的 Recall@K 未验证；ANN 后过滤的完整性没有保证。
- 性能数字都带规模与硬件条件，本页不承诺延迟。

## 延伸阅读

- [Vector Adapter 契约](https://github.com/fengjutian/WeiSQL/blob/main/docs/VECTOR_ADAPTER_CONTRACT.md)
- [TypeScript 精确搜索基线](https://github.com/fengjutian/WeiSQL/blob/main/docs/EXACT_VECTOR_BASELINE.md)
- [SDK API 契约](https://github.com/fengjutian/WeiSQL/blob/main/docs/SDK_API_CONTRACT_V1.md)
