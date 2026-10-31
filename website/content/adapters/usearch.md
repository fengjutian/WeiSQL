---
title: USearch ANN Adapter
description: 在 Node.js 中用 USearch HNSW 做近似向量检索，理解召回依赖分布、过滤限制、持久化索引与取消语义。
sidebar_position: 32
---

`@weisql/usearch-adapter` 用 USearch 的 HNSW 索引实现 `VectorAdapter`，通过 `open({ vectorAdapter })` 注入后，`db.vector.search()` 走近似检索。读完本页你应当能判断是否该用 ANN、如何生成持久化索引，以及为什么召回数字必须和目标数据一起报告。

它不会假装精确：每条命中都带 `diagnostics.exact: false`，能力声明也是 `vectorExactSearch: false`。需要严格最近邻时，不要注入这个适配器。运行时要求 Node.js 22+，USearch 以预编译二进制提供。

## 最小示例

```ts
import { readFile } from "node:fs/promises";
import { open, NodeFileResourceReader } from "@weisql/sdk";
import { createUSearchAdapter } from "@weisql/usearch-adapter";

const manifest = JSON.parse(await readFile("./demo/manifest.json", "utf8"));

const db = await open({
  manifest,
  resourceReader: new NodeFileResourceReader({ rootDirectory: "./demo" }),
  vectorAdapter: createUSearchAdapter({
    expansionSearch: 512,
    filtering: "reject",
  }),
});

const hits = await db.vector.search("document_embeddings", query, { topK: 10 });
console.log(hits[0]?.diagnostics); // { backend: "usearch-hnsw", exact: false }
```

没有声明索引的包会在首次检索时现场构建。要跳过这次构建，先生成持久化索引并回写 Manifest：

```bash
node tools/build-ann-index.mjs ./my-package --connectivity 16 --expansion-add 128 --expansion-search 512
npx weisql validate ./my-package
```

命令写入 `indexes/<collection>.usearch`，并把 `engine`、`version`、`file`、`params` 写回 Manifest；写盘前会重新校验。`weisql validate` 会把索引文件纳入 L3 校验。

## 选项

| 选项 | 类型 | 默认值 | 作用 |
| --- | --- | --- | --- |
| `connectivity` | `number` | 16 | HNSW 图的度数 |
| `expansionAdd` | `number` | 128 | 插入时的候选列表大小 |
| `expansionSearch` | `number` | 512 | 检索时的候选列表大小，直接影响召回 |
| `buildBatchRows` | `number` | 4096 | 构建索引时每批加入的行数 |
| `filtering` | `"reject" \| "post-filter"` | `"reject"` | 带 `filter` 的查询如何处理 |
| `filterOversample` | `number` | 8 | 后过滤时候选窗口的放大倍数 |

`persistedIndex` 由 Manifest 是否声明 `index` 决定，不是构造参数。

## 行为与边界

### 索引加载与构建

- Manifest 声明了索引：`open()` 后首次检索加载 `indexes/<collection>.usearch`，跳过构建；
- 没有声明索引：首次检索读取全部向量并现场构建 HNSW，100k × 128 合成数据约 10–15 秒；
- 持久化索引的 `index.params` 必须提供 connectivity / expansion；缺失时**拒绝加载**，不回退默认值；
- 目前只校验 `engine` 与向量数量，不校验 USearch 版本是否与构建时一致；
- 索引常驻内存：100k × 128 约 66 MB，比原始向量 51 MB 更大。

### 距离映射

USearch 的原始距离与 WeiSQL 公共契约不一致，Adapter 在边界处转换：

| WeiSQL 指标 | USearch 度量 | USearch 返回值 | 转换 |
| --- | --- | --- | --- |
| `cosine` | `cos` | `1 - cosine similarity` | 直接使用 |
| `l2` | `l2sq` | 平方欧氏距离 | `Math.sqrt` |
| `ip` | `ip` | `1 - dot product` | `distance - 1`，得到 `-dot` |

测试用 SDK 自己的 `vectorDistance()` 对同一组数据逐条比对，容差 `1e-4`，三种指标都覆盖。

### 能力声明

| 能力 | 值 | 含义 |
| --- | --- | --- |
| `vectorAnnSearch` | `true` | Runtime 支持近似检索 |
| `vectorExactSearch` | `false` | 结果不保证严格最近邻 |
| `hybridSearch` | `false` | 近似后端不提供混合检索路径 |
| `metadataFiltering` | `false` | Adapter 自身不解析过滤条件 |
| `postFiltering` | 取决于 `filtering` | 开启 `post-filter` 时为 `true` |
| `persistedIndex` | `true` | 支持加载 Manifest 声明的索引 |
| `cancellation` | `"unsupported"` | 检索本身无法中断 |

前三个来自 Runtime 的 `db.capabilities()`，其余来自 Adapter 的能力声明。

### 召回取决于数据分布

`expansionSearch` 默认 512，但这不是召回保证。100k × 128 合成数据、Top-10 的实测：

| 分布 | `expansionSearch` | Recall@10 均值 | 最低 |
| --- | --- | --- | --- |
| 均匀随机 | 512 | 0.735 | 0.400 |
| 100 簇，spread 1.0（重叠） | 512 | 0.740 | 0.100 |
| 100 簇，spread 0.35 | 512 | 0.685 | 0.000 |
| 10 簇，spread 0.35 | 512 | 0.590 | 0.000 |
| 100 簇，spread 0.1（很紧） | 512 | 0.385 | 0.000 |
| 100 簇，spread 0.1 | 2048 | 0.760 | 0.000 |

簇越紧，真实 Top-10 越接近「几乎等距的近重复点」，微小误差就会改变集合重叠。把 `expansionSearch` 提高 4 倍只把 0.385 恢复到 0.76，最低值仍是 0。这些数字来自合成数据，**不能外推到真实 embedding**；上线前必须用目标数据测。

### 过滤

默认 `filtering: "reject"`：Runtime 在调用前就拒绝带 `filter` 的查询，Adapter 也拒绝 `allowedRows`，错误码为 `SQL_UNSUPPORTED`。原因是候选窗口无法产出过滤子集上的严格最近 K。

显式开启 `filtering: "post-filter"` 后会扩大候选窗口直到凑够允许行，但结果**不保证完整**，诊断带 `diagnostics.postFiltered: true`。它适合「宁可少返回也要近似加速」的场景，不适合把结果当成完整答案。

### 取消与生命周期

取消能力是 `unsupported`：构建阶段只在批次之间检查 `AbortSignal`，检索本身无法中断。`close()` 幂等，关闭后查询返回 `DATABASE_CLOSED`。

### 未实现与未验证

- 按数据集的 Recall@K 与延迟报告：仓库没有真实 embedding 语料；
- 过滤与 ANN 的完整性：只有显式后过滤，且不保证完整；
- 索引与 Adapter 版本的兼容性策略：只按主版本判定，无法探测同主版本内的格式变化；
- 多机、冷缓存与浏览器端 ANN 均未验证。

### 验证方式

```bash
# 生成持久化索引，再跑完整校验
node tools/build-ann-index.mjs ./my-package --expansion-search 512
npx weisql validate ./my-package --l4

# 用精确结果做 ground truth，观察逐查询召回
npm run bench -- --ann --expansion-search 512
```

`bench --ann` 会保留 `perQuery`，不要只看均值。换 `--clusters` 与 `--cluster-spread` 可以看到同一份数据在不同分布下的召回差异。

## 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `SQL_UNSUPPORTED` | 默认模式下传了 `filter` | 去掉过滤，或显式开启 `post-filter` 并接受不完整结果 |
| `INVALID_ARGUMENT` | 查询维度、Top-K 或向量值非法 | 核对集合维度；Top-K 必须是正安全整数 |
| `INDEX_NOT_FOUND` | 未注入 `resourceReader` | 提供 Reader 后重试 |
| 首次查询特别慢 | 没有持久化索引，现场构建 | 运行 `tools/build-ann-index.mjs` 并重新校验 |
| 召回明显偏低 | `expansionSearch` 太小或数据分布紧 | 用目标数据扫描参数；不要只看均值 |
| 索引加载被拒 | Manifest `index.params` 缺失 | 用工具重新生成索引，不要手写参数 |

## 延伸阅读

- [向量检索](/docs/sdk/vector-search)：`vector.search()` 的公共语义与诊断字段。
- [过滤与混合检索](/docs/sdk/text-and-hybrid)：`filter` 的取值与 `exact-filter-first`。
- [构建数据包](/docs/tooling/build-package)：Manifest 与索引文件的生成链路。
- [基准测试](/docs/tooling/benchmarks)：`--ann` 如何用精确结果做 ground truth。
- [限制](/docs/reference/limitations)：ANN 召回与过滤的边界。
- [USearch Adapter 设计](https://github.com/fengjutian/WeiSQL/blob/main/docs/USEARCH_ADAPTER.md)。
- [ANN 可行性探测](https://github.com/fengjutian/WeiSQL/blob/main/docs/ANN_FEASIBILITY.md)。
