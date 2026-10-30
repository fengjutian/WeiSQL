# USearch ANN Adapter（Node.js）

- 包：`@weisql/usearch-adapter`
- 契约：实现 `VectorAdapter`（见 `VECTOR_ADAPTER_CONTRACT.md`），通过 `open({ vectorAdapter })` 注入
- 状态：内存索引首版；**持久化索引未实现**，召回未按数据集评估

## 1. 用法

```ts
import { open, NodeFileResourceReader } from "@weisql/sdk";
import { createUSearchAdapter } from "@weisql/usearch-adapter";

const db = await open({
  manifest,
  resourceReader: new NodeFileResourceReader({ rootDirectory: "./demo" }),
  vectorAdapter: createUSearchAdapter({ expansionSearch: 512 }),
});

const hits = await db.vector.search("document_embeddings", query, { topK: 10 });
// hits[i].diagnostics → { backend: "usearch-hnsw", exact: false }
```

`capabilities()` 会变成 `vectorAnnSearch: true`、`vectorExactSearch: false`、`hybridSearch: false`。

## 2. 距离映射（实测，不是猜测）

USearch 的原始距离与公共契约不一致，Adapter 在边界处转换：

| WeiSQL 指标 | USearch 度量 | 实测返回值 | 转换 |
| --- | --- | --- | --- |
| `cosine` | `cos` | `1 - cosine similarity` | 直接使用 |
| `l2` | `l2sq` | **平方**欧氏距离 | `Math.sqrt` |
| `ip` | `ip` | `1 - dot product` | `distance - 1`（得到 `-dot`） |

测试用 SDK 自己的 `vectorDistance()` 对同一组数据逐条比对，容差 `1e-4`，三种指标都覆盖。

## 3. 成本与限制

| 项目 | 现状 |
| --- | --- |
| 索引构建 | 首次检索时**现场构建**：完整读取一次向量文件并插入 HNSW；100k × 128 约 10 秒（合成数据实测） |
| 持久化 | 未实现。Manifest 的 `index` 只有 `{engine, version, file}`，缺少 connectivity / expansion 等构建参数，加载时无法复现同一索引 |
| 过滤 | 不支持。Runtime 在调用近似 Adapter 前就拒绝带 `filter` 的查询（`SQL_UNSUPPORTED`），Adapter 侧也会拒绝 `allowedRows` |
| 召回 | **不保证**。`expansionSearch` 默认 512 只是折中：合成数据上 512 ≈ 0.73、2048 ≈ 1.0、64 ≈ 0.17。必须按真实数据集测 Recall@K |
| 取消 | `unsupported`。构建阶段只在批次之间检查 `AbortSignal`；检索本身无法中断 |
| 内存 | 索引常驻内存（100k × 128 约 66 MB，比原始向量 51 MB 更大） |

## 4. 为什么默认 `expansionSearch` 是 512

探测阶段发现默认值 64 在合成数据上 Recall@10 只有 0.167——它能让延迟看起来漂亮，但结果是错的。512 在同等条件下约 0.73，延迟从 1.1 ms 升到 7 ms，仍然远低于精确扫描的 151 ms。

但这仍然**不是**一个可以承诺的召回率：不同数据分布差异极大，且本项目没有真实 embedding 数据集。上线前必须用真实数据测。

## 5. 尚未完成

1. 持久化索引：Builder 侧生成、Manifest 描述参数、Adapter 加载。
2. 按数据集的 Recall@K 与延迟报告（`BENCHMARK_PROTOCOL_V1.md` 要求）。
3. 过滤与 ANN 的组合语义（目前明确不支持，而不是悄悄后过滤）。
