# ANN 可行性探测（REQ-303）

- 引擎：`usearch` 2.26.5（Apache-2.0，Node ≥ 22，自带 win32-x64 等预编译二进制）
- 探针：`tools/ann-probe.mjs`
- 结论：**技术可行，但不构成接入理由**；默认参数下召回率不可接受，且索引比原始向量更大

## 1. 怎么跑

```bash
npm i --no-save usearch          # 24 MB，含原生二进制
COUNT=100000 DIMS=128 QUERIES=10 EXPANSION_SEARCH=512 node tools/ann-probe.mjs
```

探针不接触 SDK：它只回答「能不能用、代价是什么」，不回答「怎么接线」。

## 2. 实测（100,000 × 128，均匀分布 [-1,1]）

| `expansion_search` | Recall@10 | p50 | p95 |
| --- | --- | --- | --- |
| 64（近似默认） | **0.1667** | 1.15 ms | 1.52 ms |
| 512 | 0.7333 | 7.02 ms | 8.59 ms |
| 2048 | **1.0000** | 23.70 ms | 32.83 ms |
| 精确扫描（基准装置同机对比） | 1.0000 | 151.3 ms | 176.9 ms |

同一次运行的其它数据：

| 指标 | 值 |
| --- | --- |
| 建索引 | 10.1–11.7 s |
| 索引大小 | 66.1 MB（661 B/向量，原始向量为 51.2 MB） |
| 保存 / 加载 | 231–265 ms / 115–121 ms |
| 加载后 Top-1 | 与内存索引一致 |

小规模对照（20,000 × 64）：建索引 572 ms，`expansion_search=64` 时 Recall@10 = 0.70。

## 3. 这些数字说明什么

1. **默认参数不可用。** `expansion_search=64` 在随机数据上只召回 1.7/10 个真近邻。ANN 不是「换了就更快」的开关；不调参就上线等于静默降低结果质量。
2. **召回要靠延迟换。** 要到 Recall@10 = 1.0 需要 `expansion_search=2048`，延迟 23.7 ms，是同机精确扫描（151 ms）的约 1/6。
3. **索引比原始向量还大。** 661 B/向量 vs 256 B/向量的原始 Float32，索引 66 MB > 向量 51 MB。宣称「ANN 节省空间」在这里是错的。
4. **随机均匀分布是最不利的场景。** 真实 embedding 通常更成簇，召回率会更高；但本项目没有任何真实 embedding 数据集，所以不能以此推断真实场景表现。
5. **样本很小。** Recall 只用了 3 条查询，统计意义有限。

## 4. 为什么还没接入 SDK

接入不只是 import 一个库，至少需要三件事，目前都不具备：

1. **Vector Adapter 注入点**：`SqlAdapter` 已有 `open/query/close` 注入边界，向量侧还是写死在 Runtime 里的精确扫描。要做 ANN 必须先定同等形状的 `VectorAdapter` 契约，并让 `capabilities().vectorAnnSearch` 如实反映。
2. **索引构建与持久化流程**：Manifest 的 `index` 字段只有 `{engine, version, file}`，没有度量、维度之外的结构参数（connectivity、expansion）。加载时必须知道这些参数才能 `Index.load()`，否则只能靠猜测或额外的旁路配置。
3. **按数据集测量召回**：V0.8 要求 ANN 结果额外报告 Recall@K。没有真实数据集就没有可发布的召回结论，而 ANN 的召回又不能跨数据集外推。

## 5. 结论

- 记录为「可行且已接入」（`@weisql/usearch-adapter`），但默认仍走精确扫描：必须显式注入 Adapter 才会使用 ANN。
- 精确扫描仍是唯一保证正确的路径；ANN 结果的 `diagnostics.exact` 恒为 `false`。
- 召回与延迟的对照已可通过 `npm run bench -- --ann` 复现（见 `BENCHMARK_HARNESS.md` §2）：100k × 128 上 ANN 比精确快约 9.5 倍，但 Recall@10 在 0.385–0.740 之间随数据分布变化（均匀 0.735、紧聚类 0.385），提高 `expansionSearch` 只部分恢复。**数据分布必须与召回一起报告。**
- 若要对外承诺性能或召回，前提是：真实 embedding 数据集、多机复现、冷缓存对照，以及按数据集报告 Recall@K。当前一条都不满足。
