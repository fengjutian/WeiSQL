---
title: 能力矩阵
description: 按 SDK、Node.js、浏览器与 Adapter 分组列出已实现、已测试与未验证的能力，并标注每条结论的实测条件。
sidebar_position: 51
hero:
  kicker: "参考"
  title: "能力矩阵：能用，还是只是写了？"
  lead: "按 SDK、Node、浏览器与 Adapter 分组，区分已测试、探针与未验证。"
  chips: ["已测试", "探针", "未验证"]
hide_title: true
---


本页回答“这项能力现在能不能用、被验证到什么程度”。所有状态以仓库当前的实现与测试为准，性能数字只在标注的条件下成立。

## 怎么读这张表

| 状态 | 含义 |
| --- | --- |
| 已实现 · 已测试 | 有自动化测试覆盖公开行为 |
| 已实现 · 探针 | 有真实浏览器探针，但没有完整单元测试矩阵 |
| 已实现 · 未验证 | 代码存在，缺少目标场景的测量（真实数据、真实 CDN、大表等） |
| 未实现 | 当前没有可用实现 |

测试规模来自 `docs/PROJECT_STATUS.md` 的快照：五个包合计 330 个测试（SDK 209、DuckDB 25、DuckDB-Wasm 39、USearch 13、CLI 44）。数量会随提交变化，别把它当版本承诺。

## SDK 与格式层

| 能力 | 状态 | 依据与条件 |
| --- | --- | --- |
| Manifest V1 结构校验（L1） | 已实现 · 已测试 | 必填字段、未知字段、版本、路径形状 |
| Manifest 语义校验（L2） | 已实现 · 已测试 | 跨字段引用、计数与字节公式、路径唯一性 |
| 资源完整性（L3，`manifest` 模式） | 已实现 · 已测试 | 只比对长度，不读内容 |
| 资源完整性（L3，`all` 模式） | 已实现 · 已测试 | 增量 SHA-256 + ID Map 内容与偏移校验 |
| Parquet 内容校验（L4） | 已实现 · 已测试 | 经 DuckDB Adapter 比对列名、类型与行数 |
| HTTP Range 读取 | 已实现 · 已测试 | 严格校验 `206`、`Content-Range`、响应长度与取消 |
| Node 文件读取 | 已实现 · 已测试 | 包根 containment、符号链接逃逸防护、精确范围读取 |
| 有界 LRU 缓存 | 已实现 · 已测试 | 按字节淘汰、并发合并、版本隔离、命中统计 |
| Runtime 生命周期 | 已实现 · 已测试 | `open()` 双来源、`capabilities()`、只读 `state`、幂等 `close()` |
| 精确向量检索 | 已实现 · 已测试 | 100k × 128、20 查询，p50 129–152 ms，51.2 MB I/O/查询，单机热缓存 |
| 过滤混合检索 | 已实现 · 已测试 | `exact-filter-first`（严格）与 `vector-first`（有界窗口） |
| 全文检索 BM25 | 已实现 · 已测试 | 100k 文档，p50 10.2–10.8 ms，索引 74.2 MB |
| RRF 融合 | 已实现 · 已测试 | 按排名融合；只测了 `k` 的稳定性，没测排序质量 |
| RAG 证据组装 | 已实现 · 已测试 | 字符预算内返回片段；截断落在句末或词边界 |
| Builder（生成数据包） | 已实现 · 已测试 | 接收已有 Parquet，生成向量、ID Map、摘要，自检后原子发布 |
| CSV/JSON → Parquet | 已实现 · 已测试 | 只覆盖标量类型，保守推断 |
| `.wsql` 容器 | 已实现 · 已测试 | 未压缩 1.0.0 与 gzip 1.1.0；`ContainerReader` / `StreamingContainerReader` |
| Ed25519 签名 | 已实现 · 已测试 | 单签、多签、轮换、根密钥授权；篡改与过期均拒绝 |
| 发布前静态检查 | 已实现 | `npm run release:check`，CI 中执行 |

## Node.js 运行时

| 能力 | 状态 | 依据与条件 |
| --- | --- | --- |
| 只读 SQL（DuckDB） | 已实现 · 已测试 | `@duckdb/node-api` 2.x，依赖原生绑定 |
| SQL 流式读取 | 已实现 · 已测试 | `sqlStream()` 分批读取；`maxRows` 在迭代中强制 |
| 表加载 `memory`（默认） | 已实现 · 已测试 | `CREATE TABLE ... AS SELECT`，关闭外部文件访问 |
| 表加载 `lazy` | 已实现 · 已测试 | 临时文件 + 视图，保留外部访问；仅适合应用作者编写的 SQL |
| 参数绑定 | 已实现 · 已测试 | `Date` → UTC 微秒，`Uint8Array` → BLOB |
| 结果行数预算 `maxRows` | 已实现 · 已测试 | 超限抛 `INVALID_ARGUMENT`，不截断；引擎提前停止 |
| 取消 | 已实现 · 已测试 | 原生 `connection.interrupt()`，返回 `QUERY_CANCELLED` |
| 两层字节预算 | 已实现 · 已测试 | 单表默认 256 MiB，整包默认 512 MiB |
| 原生绑定跨平台 | 已实现 · 未验证 | 预编译覆盖 win32-x64 / linux-x64 / darwin；未做矩阵实测 |

## 浏览器运行时

| 能力 | 状态 | 依据与条件 |
| --- | --- | --- |
| 只读 SQL（DuckDB-Wasm） | 已实现 · 探针 | Chromium 1248，`probe:wasm` 断言 |
| `open()` 耗时 | 已实现 · 已测试 | 3 行表、扩展同源且已缓存：1.37–1.70 s |
| 参数化查询 | 已实现 · 已测试 | 3 行表，< 50 ms |
| SQL 流式读取 | 已实现 · 已测试 | `sqlStream()` 分批迭代；`maxRows` 逐行检查 |
| 只读 CTE | 已实现 · 探针 | 依赖 DuckDB tokenizer；tokenizer 不可用时退回严格白名单 |
| 过滤检索 | 已实现 · 探针 | `exact-filter-first`，`exact: true` |
| 取消 | 已实现 · 已测试 | `best-effort`；202 ms 查询在 50 ms abort 后 51 ms 返回，引擎未停 |
| parquet 扩展自托管 | 已实现 · 已测试 | 498,915 B（`wasm_eh`，v1.4.3），必须同源 |
| 两层字节预算 | 已实现 · 已测试 | 单表默认 64 MiB，整包默认 128 MiB，早于 WASM 加载 |
| 浏览器内大表与冷启动 | 已实现 · 部分实测 | 本地 Chromium 已测 200k/500k/1M 行与关闭缓存的 36.3 MB 首载；真实 CDN 网络未测 |
| OPFS 持久化 | 已实现 · opt-in | `persistToOpfs`；内容派生键，命中后仍跑 L4，跨标签页用 Web Locks |
| WASM 向量模块 | 已实现 · 随包 | exact 与 HNSW 两个 `.wasm` 在 `@weisql/sdk/wasm`，含 `artifacts.json`；浏览器实测未做 |

## Adapter

| 能力 | 状态 | 依据与条件 |
| --- | --- | --- |
| `SqlAdapter` 注入边界 | 已实现 · 已测试 | `open({ sqlAdapter })`，SDK 保持零引擎依赖 |
| `VectorAdapter` 注入边界 | 已实现 · 已测试 | `open({ vectorAdapter })`，ANN 必须声明 `exactSearch: false` |
| USearch HNSW（持久化索引） | 已实现 · 已测试 | 加载 Manifest 声明的索引；缺参数时拒绝加载 |
| USearch HNSW（现场构建） | 已实现 · 已测试 | 未声明索引时首次检索构建，100k × 128 约 10 s |
| USearch 度量映射 | 已实现 · 已测试 | `cos` 直接、`l2sq` 开方、`ip` 减一；容差 1e-4 |
| ANN Recall@K | 已实现 · 未验证 | 合成数据 0.385–0.740，强依赖分布；真实语料未测 |
| ANN 后过滤 | 已实现 · 已测试 | 显式开启，不保证完整，`diagnostics.postFiltered` 自曝 |
| ANN 取消 | 未实现 | 只在构建批次间检查 `AbortSignal`，检索无法中断 |

## 跨环境一致性

| 能力 | 状态 | 依据与条件 |
| --- | --- | --- |
| Node ↔ Chromium 结果对照 | 已实现 · 已测试 | `probe:parity`：8 向量 + 5 文本 + 9 SQL + RAG + 容器 + 6 个非法 Manifest |
| SQL 共享契约 | 已实现 · 已测试 | 同一组用例跑两个 Adapter，差异必须显式声明 |
| 浏览器路径 | 已实现 · 探针 | HTTP Range、L3、精确搜索、缓存命中 |
| 高维/大数集一致性 | 未验证 | 对照只用 2 维 3 条记录 |
| 真实 CDN 行为 | 未验证 | 需要实际部署环境验证 CORS、Range 与缓存 |

## 验收命令

```bash
npm test                # 单元与集成测试
npm run test:contract   # 同一套 SQL 契约跑 Node 与 DuckDB-Wasm
npm run probe:browser   # Chromium：Range、L3、精确搜索、缓存
npm run probe:wasm      # Chromium：DuckDB-Wasm 物化与只读拒绝
npm run probe:parity    # Node 与 Chromium 逐字段对照
npm run bench           # 合成数据基准，含完整性闸门
```

CI 覆盖构建、类型、测试、发布元数据、派生文件可复现性、容器打包、`bench:wasm` 冒烟、SQL 共享契约，以及 `browser` 作业中的四个 Chromium 探针。完整的 `bench` / `bench:wasm` 不在 CI 内，需要 Python 与稳定机器；数字要本地复现并注明环境。

## 这张表不能推出的结论

- 不能推出“百万级向量有固定延迟”：只在 100k × 128 上测过，且是合成数据。
- 不能推出“浏览器内存够用”：物化预算只是拒绝阈值，浏览器大表未测。
- 不能推出“ANN 召回够用”：0.385 的最差值出现在紧聚类分布。
- 不能推出“CDN 上一定工作”：真实 CORS 与缓存行为未验收。
- 不能推出“npm 可直接安装”：五个包尚未发布。

相关页面：[兼容性](/docs/reference/compatibility)、[已知限制](/docs/reference/limitations)、[基准测试](/docs/tooling/benchmarks)。
