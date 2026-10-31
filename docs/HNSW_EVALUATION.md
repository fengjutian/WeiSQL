# HNSW 真实数据评估手册

- 状态：工具已就绪，等待真实 embedding 数据
- 适用范围：`crates/vector-hnsw` 与 `crates/vector-hnsw-wasm`
- 相关：`docs/BENCHMARK_HARNESS.md` 3.7 节（已有基线数字）

## 1. 先明确前提

HNSW 是**近似**索引：`search()` 返回的是候选窗口内的最近邻，不保证等于精确扫描。
因此任何“性能提升”都必须同时给出**同一份数据、同一组查询**上的 Recall@K；只报延迟没有意义。

本仓库已有的基线大多来自合成聚类数据，Recall 接近 1.00。聚类数据对图索引天然友好，
不能外推。本手册的目的就是用真实 embedding 替换掉这一类乐观数字。

## 2. 数据格式

评估工具读取**原始小端 float32、row-major** 文件：

```
rows × dimension × 4 字节，无 header
第 i 行第 j 维位于 offset = (i * dimension + j) * 4
```

这与 SDK 的向量块（`f32-le-row-major`）和常见 `.f32` dump 一致。要求：

- 字节数必须精确等于 `rows × dimension × 4`，工具会拒绝不匹配的输入；
- 每个值必须有限；cosine 数据不能含零向量（否则余弦距离无定义）；
- 不要先在外部做 L2 归一化再声称测的是 cosine——两种输入的图结构不同；
- 如果来源是 `.npy`，先去掉 header 转成裸 f32，或写一个几行的转换脚本。

生成一份可复现的随机数据用于自测（不用于对外结论）：

```bash
node -e "const fs=require('fs');const n=10000*256;const a=new Float32Array(n);let s=7;for(let i=0;i<n;i++){s=(Math.imul(s,1664525)+1013904223)>>>0;a[i]=s/4294967296-0.5;}fs.writeFileSync('random-10k-256.f32',Buffer.from(a.buffer))"
```

## 3. 跑一次评估

```bash
# 真实数据
npm run bench:hnsw-dataset -- \
  --file embeddings.f32 --rows 100000 --dim 768 --metric cosine \
  --queries 50 --top-k 10 --m 16 --ef-construction 200 --ef-search 64
```

输出是固定的 `key=value` 行，便于直接贴进报告：

| 字段 | 含义 |
| --- | --- |
| `source` | 输入文件或 `synthetic-*` |
| `build_ms` | 单线程 WASM 建图耗时 |
| `index_bytes` | 序列化索引体积（含原始向量） |
| `hnsw_p50_ms` / `hnsw_p95_ms` | WASM 检索延迟（不含 JS 与网络的向量读取） |
| `exact_js_p50_ms` | 同一数据、同一查询的 JavaScript 精确扫描耗时（对照，不是产品路径） |
| `recall_at_k` | HNSW Top-K 与精确 Top-K 的交集比例 |

`--queries` 决定抽样查询数（按行号均匀取），`--top-k` 同时决定两边的 K。
`--metric` 必须与数据用途一致；cosine 与 l2 的排序结果不同，不能混用。

## 4. 调参与记录

建议分两步：

1. **先用 10k 行子集**扫 `--ef-search`（32 / 64 / 128 / 256），记录 recall 与 p50 的折中；
2. 选定后再对全量数据建图，并记录建图时间、索引体积与内存。

记录模板：

```text
环境：CPU / 内存 / OS / Node 版本 / 是否 WASM（本手册全部为 WASM）
数据：来源、rows、dim、metric、是否归一化、查询来源（数据行 or 独立 query 集）
参数：m / ef_construction / ef_search / top_k / queries
结果：build_ms / index_bytes / hnsw_p50 / hnsw_p95 / exact_js_p50 / recall_at_k
结论：在 recall ≥ 目标值（例如 0.95）时的延迟与体积；低于目标时说明差距
```

**不要把不同数据集的 recall 放在同一张表里比较**；表头必须带数据几何说明。

## 5. 把结论固化到构建流程

数据层面达标后，用构建期召回门禁防止参数回退：

```bash
node tools/build-ann-index.mjs ./my-package --engine hnsw \
  --recall-samples 50 --recall-top-k 10 --min-recall 0.95
```

采样是确定性的行号，对照是同一份向量的精确扫描；`--min-recall` 不达标时命令失败，
不会写出“质量未知”的索引。`recall` 只出现在构建输出里，不写进 Manifest。

## 6. 已知限制

- 建图是单线程 WASM，比原生慢；10k×256 约 62 s（见 3.7 节）；
- 图不可增量更新：集合或度量变化会整图重建；
- 一个 WASM 实例同时只持有一个图，多集合查询会来回重建；
- 序列化索引包含原始向量，体积约为向量数据 + 邻接表；
- 没有真实数据集上的官方基线，本手册的模板填完才算。

## 7. 现有基线（仅作量级参考）

| 规模 | 分布 / 度量 | 建图 | HNSW p50 | 精确 JS p50 | Recall@10 |
| --- | --- | --- | --- | --- | --- |
| 10k × 32 | clustered / l2 | 2.1 s | 0.25 ms | 3.67 ms | 1.000 |
| 10k × 256 | random / cosine | 61.8 s | 1.05 ms | 9.49 ms | 0.950 |
| 50k × 64 | clustered / l2 | 42.0 s | 0.60 ms | 24.2 ms | 0.997 |

随机 256 维已经掉到 0.95，真实 embedding 通常介于两者之间；以实测为准。
