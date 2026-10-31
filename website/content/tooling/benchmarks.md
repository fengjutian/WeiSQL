---
title: 基准测试
description: 运行可复现的精确检索、ANN、全文与 DuckDB-Wasm 基准，理解测量条件、数字边界与探针分工。
sidebar_position: 43
hero:
  kicker: "工具链 · 测量"
  title: "基准是测量设备，不是性能承诺"
  lead: "p50/p95、I/O、内存与 Recall@K 都要带条件报告。"
  chips: ["bench", "probe", "p50"]
hide_title: true
---


`npm run bench` 是一台测量装置，不是性能承诺：它生成固定种子的合成数据包，先做完整性闸门，再测 `open()`、查询延迟、I/O 字节与峰值内存。读完本页你应当能复现一组数字，并说明这些数字为什么不能外推到真实语料、浏览器或 CDN。

仓库里的所有性能数字都来自单机、单次运行、热页缓存；没有多机复现，也没有真实 CDN 验收。

## 最小示例

```bash
# 默认：100k 向量 × 128 维，20 条查询
npm run bench

# 换规模，并跑 ANN 对照
npm run bench -- --rows 20000 --dimension 64 --queries 10
npm run bench -- --ann --expansion-search 512

# DuckDB-Wasm 物化（Node 里的同一 WASM 构建）
npm run bench:wasm
npm run bench:wasm -- --smoke
```

## 命令与选项

| 命令 | 作用 |
| --- | --- |
| `npm run bench` | 合成包、完整性闸门、精确检索、I/O 与内存 |
| `npm run bench -- --ann` | 同进程对照精确检索与 USearch ANN，计算 Recall@K |
| `npm run bench -- --text` | 构建 BM25 索引并测查询延迟与体积 |
| `npm run bench -- --fusion` | 对 RRF 的 `k` 做敏感性对照 |
| `npm run bench -- --filter` | 测 `exact-filter-first` 的 I/O 与延迟 |
| `npm run bench:wasm` | DuckDB-Wasm 物化与过滤查询，默认 50k/200k/500k 行 |
| `npm run bench:quantization` | f32/f16/i8 索引的体积与召回对照 |
| `npm run bench:recall` | 用真实 `.npy`/`.f32` 语料测 Recall@K（仓库内无语料） |

`bench` 的常用参数：

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `--rows` | 100000 | 向量行数 |
| `--dimension` | 128 | 向量维度 |
| `--queries` | 20 | 查询条数 |
| `--topk` | 10 | Top-K |
| `--package` | `bench/pkg-<rows>x<dimension>` | 复用已生成的包 |
| `--no-generate` | 关闭 | 跳过合成包生成 |
| `--ann` | 关闭 | 增加 ANN 对照 |
| `--expansion-search` | 512 | ANN 检索候选列表 |
| `--text` | 关闭 | 增加全文检索测量 |
| `--fusion` | 关闭 | 增加 RRF `k` 对照 |
| `--filter` | 关闭 | 增加过滤查询测量 |
| `--clusters` | 0 | 生成 N 个高斯簇；0 表示均匀随机 |
| `--cluster-spread` | 0.35 | 簇的紧度，越小越紧 |

`bench:wasm` 接受位置参数作为行数，例如 `npm run bench:wasm -- 50000 200000`；`--smoke` 只跑 1k 行，CI 用它验证接线。

## 行为与边界

基准装置的行为是固定的：先验证数据，再测量；测量过程不修改包；每次运行都打印环境；任何一步失败都不会产出可比较的数字。

### 测量流程

1. 用 pyarrow 写入 Parquet、Float32 向量、ID Map 与 Manifest，随机种子固定；
2. 用 `@weisql/cli` 的 `validatePackage(mode: "all")` 做完整性闸门，不通过直接退出；
3. 用 `NodeFileResourceReader` + `open()` 打开包，记录耗时；
4. 用固定种子 `12345` 生成查询向量，逐条计时，报告 cold / min / p50 / p95 / max / avg；
5. 包装 Reader，统计 Range 请求数与读取字节数；
6. 每 20 ms 采样 `process.memoryUsage().rss`，报告峰值；
7. 打印 CPU、核数、内存、平台与 Node 版本。

测量装置保留 `perQuery` 召回，避免只看均值掩盖方差。生成的包写入 `bench/`（已 gitignore），合成包需要 Python + pyarrow。

## 实测结果

以下数字的环境统一为：Intel Core Ultra 7 155H · 22 核 · 32 GiB · Windows 10.0.26200 x64 · Node v24.14.1；单机、单次运行、热页缓存。

### 精确检索

| 规模 | 向量字节 | 校验 | `open()` | p50 | p95 | 峰值 RSS | 每查询读取 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5,000 × 32 | 640 KB | 36 ms | 0.4 ms | 9.8 ms | 13.8 ms | 56 MiB | 640 KB |
| 100,000 × 128 | 51.2 MB | 437 ms | 0.5 ms | 151.3 ms | 176.9 ms | 112 MiB | 51.2 MB |

可读出的事实：每次查询都要完整扫过向量文件，`rangeBytesPerQuery` 恰好等于 `vectorBytes`；分块读取降低峰值内存，不降低总 I/O。100k × 128 的 20 次查询共 2,360 个 Range 请求，约每查询 118 个块（10 万行 ÷ 1024 行/块）。`open()` 不做预读，所以是亚毫秒级；真正的成本在第一次查询。

### ANN 对照

| 指标 | 精确 | ANN（`expansionSearch=512`） |
| --- | ---: | ---: |
| p50 | 212.6 ms | 22.4 ms |
| p95 | 275.1 ms | 26.9 ms |
| Recall@10 均值 | 1.000 | 0.735 |
| Recall@10 最低 | 1.000 | 0.400 |
| 首次查询 | — | 15.2 s（含完整索引构建） |
| 进程峰值 RSS | — | 219.7 MiB（精确与 ANN 同进程） |

这是 100,000 × 128、20 条查询的同进程对照；单独跑精确基线时 p50 是 151.3 ms。两次运行条件不同，约 9.5 倍加速只适用于这组对照，不要把它当成通用倍率。

召回强烈依赖数据分布，同一规模的 Top-10：

| 分布 | `expansionSearch` | Recall@10 均值 | 最低 |
| --- | ---: | ---: | ---: |
| 均匀随机 | 512 | 0.735 | 0.400 |
| 100 簇，spread 1.0 | 512 | 0.740 | 0.100 |
| 100 簇，spread 0.35 | 512 | 0.685 | 0.000 |
| 10 簇，spread 0.35 | 512 | 0.590 | 0.000 |
| 100 簇，spread 0.1 | 512 | 0.385 | 0.000 |
| 100 簇，spread 0.1 | 2048 | 0.760 | 0.000 |

小规模下 ANN 反而更慢：5,000 × 32 时 ANN p50 11.8 ms，精确约 10 ms，构建与图遍历开销占主导。

### 全文检索

100,000 文档、5,000 词项、平均 50 tokens/文档：

| 指标 | 数值 |
| --- | --- |
| 索引总大小 | 74.2 MB（742 B/文档） |
| 其中正文 | 33.1 MB |
| 构建耗时 | 4.5 s（含读取 Parquet 文本列） |
| 查询 p50 | 10.2–10.8 ms（三次重复） |
| 查询 p95 | 15–24 ms |
| 首次查询 | 160–223 ms |

正文占索引约 45%，只有需要 RAG 组装上下文时才应生成 `documents`。延迟由固定开销加每次命中的随机读构成：`doclengths.bin` 每次查询整读，同一数据集下仅把 topK 从 1 改到 10 也会变化（单次运行：8.1 → 16.1 ms）。BM25 是精确排序，没有召回率可报告。

### 过滤查询

100,000 × 128、10 次采样、单机热缓存：

| 查询 | 向量字节/查询 | ID Map 字节/查询 | 向量请求/查询 | p50 |
| --- | ---: | ---: | ---: | ---: |
| 无过滤 | 51.2 MB | 仅 Top-K | 98 | 156.2 ms |
| 尾部 1000 行 | 0.51 MB | 480 B | 1 | 17.1 ms |
| 约 1/3 散乱匹配 | 51.2 MB | 475 B | 98 | 175.3 ms |

窄过滤的收益主要来自持久化 `id → row` 反向索引：ID Map 从每查询 4.0 MB 降到 480 B，p50 从 327 ms 降到 17.1 ms。实现方式比结构更重要：最初逐条二分读取索引，1000 次查询发出约 17,000 次 Range 请求，延迟反而升到 5.4 s；整份索引一次载入后在内存二分，才得到上表数字。

### RRF 的 k 敏感性

100,000 文档 × 128 维、20 组查询对、每路 40 个候选：

| k | Top-10 平均重合 | Top-1 变化（/20） |
| ---: | ---: | ---: |
| 10 | 0.99 | 2 |
| 30 | 1.00 | 1 |
| 60（基线） | 1.00 | 0 |
| 100 | 1.00 | 0 |
| 200 | 1.00 | 0 |

`k ≥ 30` 时排序完全一致，因为 `k` 远大于候选列表长度，名次差异被压平。只有 `k=10` 会改变结果。这衡量的是稳定性，不是相关性质量；本实验没有标注数据，不能回答「哪个 k 排序更好」。

### DuckDB-Wasm 物化

Node 里运行与浏览器相同的 WASM 构建与适配器代码，合成数据刻意低压缩：

| 行数 | Parquet | `open()` | 过滤查询 | RSS 增量 |
| ---: | ---: | ---: | ---: | ---: |
| 50,000 | 1.9 MB | 160 ms | 5.9 ms | ~24 MB |
| 200,000 | 7.5 MB | 192 ms | 7.9 ms | ~43 MB |
| 500,000 | 18.8 MB | 298 ms | 12.9 ms | ~76 MB |

物化耗时约 0.6 ms / 1000 行，RSS 增量约为 Parquet 的 4 倍。这是 Node 里的 WASM 测量，不含浏览器 DOM/Worker 开销，也不含跨网络加载约 34 MB WASM 的冷启动。浏览器侧目前只有 3 行数据的探针，不能据此承诺浏览器内存。

## 探针与 CI

| 命令 | 验证内容 |
| --- | --- |
| `npm run probe:browser` | Chromium 中的 HTTP Range、L3、精确搜索与缓存命中 |
| `npm run probe:wasm` | Chromium 中的 DuckDB-Wasm 物化、参数绑定、只读拒绝与 CTE |
| `npm run probe:playground` | Playground 的向量、全文、RAG、容器与浏览器 SQL |
| `npm run probe:parity` | Node 与 Chromium 逐字段比较向量、全文、RAG、SQL、容器与错误码 |

CI 的 `browser` 作业会依次跑这四个探针；`derived` 作业会跑 `bench:wasm --smoke`（1k 行）验证接线。完整的 `bench` 与 `bench:wasm` **不在 CI 内**，因为合成包需要 Python，且性能数字需要稳定机器。探针比较的是语义与结果，不比较耗时。

## 如何解读

- 所有数字都是单机、单次运行、热页缓存，不是性能承诺；
- 精确检索的总 I/O 不随分块下降；ANN 用召回换速度；BM25 没有召回率；
- ANN 召回必须连同数据分布、规模与参数一起报告；
- 浏览器 SQL 的 `open()` 1.37–1.70 s 只覆盖 3 行表且扩展已缓存，首次加载还要另算 34 MB WASM；
- `maxTableBytes` 是拒绝阈值，不是内存保证；
- 没有真实 embedding 语料、第二台机器、冷缓存或真实 CDN 数据，因此不能外推到百万级向量、浏览器内存或 CDN 随机访问效率。

## 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 生成合成包失败 | 缺少 Python 或 pyarrow | 安装 pyarrow，或复用 `--package` 指向已有包 |
| 启动即失败 | 完整性闸门不通过 | 先修包；基准绝不在坏数据上跑 |
| `unknown option` | 参数拼写错误 | 对照上表；数值参数需要跟值 |
| 首次 ANN 查询很慢 | 现场构建索引，未加载持久化索引 | 先跑 `tools/build-ann-index.mjs`，或用 `--expansion-search` 做对照 |
| `probe:*` 失败找不到浏览器 | 没有 Chromium/Chrome/Edge | 安装浏览器，或设置 `CHROME_PATH` |
| 两次数字差异大 | 冷/热缓存、机器负载或数据分布不同 | 记录环境与缓存状态，不要混合比较 |

## 延伸阅读

- [USearch Adapter](/docs/adapters/usearch)：召回、过滤与持久化索引。
- [向量检索](/docs/sdk/vector-search)：精确检索的 I/O 模型。
- [全文与混合检索](/docs/sdk/text-and-hybrid)：BM25 与 RRF 的语义。
- [部署到 CDN](/docs/tooling/deploy-cdn)：为什么本机数字不能代表 CDN。
- [限制](/docs/reference/limitations)：未验证项清单。
- [基准测量装置](https://github.com/fengjutian/WeiSQL/blob/main/docs/BENCHMARK_HARNESS.md)。
- [基准测试协议](https://github.com/fengjutian/WeiSQL/blob/main/docs/BENCHMARK_PROTOCOL_V1.md)。
