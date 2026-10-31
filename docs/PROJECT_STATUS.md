# 项目状态报告

> 生成于 2026-10-31。所有数字来自本仓库的测试与基准装置，环境为单机：Intel Core Ultra 7 155H · 22 核 · 32 GiB · Windows 10.0.26200 x64 · Node v24.14.1。
> 本报告只陈述**已验证**的内容；未验证项在 §6 单独列出。

## 1. 一句话状态

工程原型：Manifest V1 与数据包格式稳定，五个包共 **326 个自动化测试**，CI 覆盖构建/类型/测试/发布元数据，精确检索、ANN、全文、融合、RAG、单文件容器与浏览器 SQL 均有实现与实测数字；**尚未发布 npm 包**，也没有任何未经测量的性能承诺。

## 2. 能力矩阵

| 能力 | 实现 | 测试 | 文档 | 实测 |
| --- | --- | --- | --- | --- |
| Manifest V1 校验（L1/L2） | ✅ | ✅ | ✅ | — |
| L3 资源完整性（尺寸 + SHA-256） | ✅ | ✅ | ✅ | ✅ |
| L4 Parquet 内容校验（CLI `--l4`） | ✅ | ✅ | ✅ | ✅ |
| HTTP / Node 文件 Reader | ✅ | ✅ | ✅ | ✅ |
| 有界 LRU 缓存 + 请求合并 | ✅ | ✅ | ✅ | — |
| Runtime 生命周期与能力报告 | ✅ | ✅ | ✅ | — |
| 精确向量检索 | ✅ | ✅ | ✅ | ✅ 129–152 ms p50 @100k×128 |
| Hybrid 过滤两策略（等值/IN/范围/日期） | ✅ | ✅ | ✅ | — |
| DuckDB 只读 SQL（memory / lazy） | ✅ | ✅ | ✅ | — |
| DuckDB-Wasm 浏览器 SQL | ✅ | ✅ + 探针 | ✅ | ✅ open() 1.37–1.70 s，查询 < 50 ms，只读 CTE 通过（3 行） |
| USearch ANN（持久化/现场构建） | ✅ | ✅ | ✅ | ✅ 0.385–0.740 Recall@10 |
| ANN 后过滤（显式可选） | ✅ | ✅ | ✅ | — |
| 全文检索 BM25 | ✅ | ✅ | ✅ | ✅ p50 ≈10.5 ms @100k 文档 |
| RRF 融合 | ✅ | ✅ | ✅ | — |
| RAG 证据组装 | ✅ | ✅ | ✅ | ✅ 端到端 |
| `.wsql` 单文件容器（pack/validate/unpack、流式、gzip 1.1.0） | ✅ | ✅ | ✅ | ✅ 3.6 KB 包往返 |
| Manifest Ed25519 签名（多签 / 轮换 / root 授权） | ✅ | ✅ | ✅ | ✅ 篡改、信任固定与有效期均拒绝 |
| 浏览器路径（Chromium） | ✅ | 探针 | ✅ | ✅ 与 Node 逐字段一致 |
| 发布前检查 + Apache-2.0 | ✅ | — | ✅ | ✅ |
| CSV/JSON → Parquet 转换工具 | ✅ | ✅ | ✅ | ✅ 回读校验 |

## 3. 包与依赖

```text
@weisql/sdk 0.1.0                零运行时依赖
├── @weisql/duckdb-adapter 0.1.0 @duckdb/node-api 2.0.0-r.1
├── @weisql/duckdb-wasm-adapter 0.1.0 @duckdb/duckdb-wasm 1.32.0
├── @weisql/usearch-adapter 0.1.0 usearch 2.26.5
└── @weisql/cli 0.1.0
```

依赖方向单向，下游对 SDK 使用 caret 范围，由 `release:check` 强制。

## 4. 测试与 CI

| 包 | 测试数 | 覆盖重点 |
| --- | --- | --- |
| `@weisql/sdk` | 209 | 校验、Reader、缓存、Builder、精确/融合/RAG、容器、随机输入错误契约、Adapter 契约 |
| `@weisql/duckdb-adapter` | 25 | 只读边界、参数绑定、两种表加载、两层字节预算、取消 |
| `@weisql/duckdb-wasm-adapter` | 38 | 关键字白名单、CTE 分类与 fail-closed、参数类型收窄、值映射、两层预算、取消、错误契约、真实 WASM 引擎集成 |
| `@weisql/usearch-adapter` | 13 | 度量映射、持久化索引、后过滤、生命周期 |
| `@weisql/cli` | 41 | 校验退出码、`--json`、`pack`/`--compress`、`unpack`、容器校验、`--l4` |
| **合计** | **326** | |

CI（`.github/workflows/ci.yml`）：

- `verify`：Ubuntu + Windows 矩阵，`npm ci` → build → typecheck → test → release:check → SQL 适配器契约 → 示例包校验；
- `derived`：fixture 可复现性（重生成后 `git status` 必须为空）→ 构建文本/ANN 索引并校验 → 打包容器并校验 → `bench:wasm` 冒烟 → SQL Adapter 共享契约（`test:contract`）；
- `browser`：Ubuntu 上复用 runner 自带的 Chrome，依次跑 `probe:browser`、`probe:wasm`、`probe:playground`、`probe:parity`。

完整的 `bench` / `bench:wasm` 仍**不在 CI 内**（需要 Python 与稳定机器）；`bench:wasm --smoke` 在 `derived` 任务里物化 1k 行。浏览器结论由 `browser` 作业验证，但性能数字仍需本地复现并注明环境。

## 5. 全部实测数字

| 指标 | 数值 | 条件 | 边界 |
| --- | --- | --- | --- |
| 精确检索 p50 | 129–152 ms | 100k × 128，20 查询 | 单机、热页缓存 |
| 精确检索 I/O | 51.2 MB/查询 | 同上 | 未做列裁剪 |
| ANN 加速 | ≈9.5× | 100k × 128，`expansionSearch=512` | 合成数据 |
| ANN Recall@10 | 0.385–0.740 | 均匀 0.735；紧聚类 0.385 | **强依赖数据分布**，见 §5.1 |
| ANN 索引构建 | 2.7–15.2 s | 同上 | 构建时间随分布变化 |
| 过滤查询（窄连续） | p50 15.1 ms | 100k 行，尾部 1000 行 | 反向索引 + 连续段读取；散乱 1/8 回退顺序扫描 135 ms |
| 量化（合成，成簇） | f16 −39% 无损 / i8 −58% 掉 9.5 点 | 50k × 128，64 簇 | 提高 expansion 不能恢复 i8；真实语料未测 |
| 全文索引体积 | 74.2 MB（742 B/文档） | 100k 文档、5000 词项、50 tokens/文档 | 其中正文 33.1 MB |
| 全文查询 p50 | 10.2–10.8 ms | 同上 | 固定开销 ≈8 ms + 每命中随机读 |
| 全文索引构建 | 4.5 s | 同上 | 含读取 Parquet 文本列 |
| 浏览器一致性 | 8 向量 + 5 文本 + 9 SQL + 5 流式 SQL + RAG + 容器 | Chromium 1248 vs Node 24 | 3 条记录、2 维，不能外推 |
| 浏览器 SQL `open()` | 1.37–1.70 s | Chromium 1248，扩展同源且已缓存 | 3 行表；首次加载另有 34 MB WASM |
| 浏览器 SQL 查询 | < 50 ms | 同上 | 3 行表，不含首次加载 |
| 浏览器 SQL 取消 | 202 ms 查询在 50 ms abort 后 51 ms 返回 `QUERY_CANCELLED` | Chromium 1248 | 引擎未停；`cancelSent()` 返回 false |
| DuckDB-Wasm 物化 50k 行 | 160 ms，RSS ~+24 MB | Node 内的同一 WASM 构建，1.9 MB Parquet | 浏览器未测 |
| DuckDB-Wasm 物化 200k 行 | 192 ms，RSS ~+43 MB | 同上，7.5 MB Parquet | 浏览器未测 |
| DuckDB-Wasm 物化 500k 行 | 298 ms，RSS ~+76 MB | 同上，18.8 MB Parquet | 约 4×Parquet；浏览器未测 |
| DuckDB-Wasm 过滤查询 | 5.9–12.9 ms | 同上，等值过滤 | 冷/热缓存未区分 |
| 物化默认预算 | 浏览器 64/128 MiB；Node 256/512 MiB（单表/整包） | 实测物化约 4× Parquet | 声明字节，不是内存承诺 |
| 浏览器流式读取 | 100k/1M/5M 行：126/871/4,542 ms，首行 5–16 ms | Chromium 1248，`sqlStream(range())` | 单次运行、合成数据，堆增量 ~14 MB @5M |
| 浏览器 Parquet 流式 | 20 万/50 万行：`open()` 1,963/2,430 ms；流式 430/2,165 ms；`db.sql` 堆 +40.6/+95.4 MB | 7.5/18.8 MB Parquet，HTTP Range + L3 + 物化 | 单次运行；50 万行吞吐降到 231k 行/s |
| 浏览器冷启动 | `open()` 1,817 ms；传输 36.3 MB（WASM 32.7 + 扩展 2.9 + worker 0.7） | Chromium 1248，CDP 关闭 HTTP 缓存 | 本地服务器，无 CDN/网络 RTT |
| parquet 扩展体积 | 498,915 B（`wasm_eh`，v1.4.3） | 自托管 | 版本必须与 WASM 核心一致 |

### 5.1 ANN 召回与分布（100k × 128，Top-10，`expansionSearch=512`）

| 分布 | 均值 | 最低 |
| --- | --- | --- |
| 均匀随机 | 0.735 | 0.400 |
| 100 簇，spread 1.0 | 0.740 | 0.100 |
| 100 簇，spread 0.35 | 0.685 | 0.000 |
| 10 簇，spread 0.35 | 0.590 | 0.000 |
| 100 簇，spread 0.1 | 0.385 | 0.000 |
| 100 簇，spread 0.1，`expansionSearch=2048` | 0.760 | 0.000 |

结论：**召回数字必须连同分布和规模一起报告**；均匀随机不是最不利情形（这一点曾被写入 ADR-030，已被 ADR-043 推翻）。

## 6. 未实现与未验证

### 6.1 外部条件阻塞

| 项 | 阻塞原因 |
| --- | --- |
| npm 发布 | 缺少组织与访问令牌；LICENSE 已确定为 Apache-2.0 |
| 真实数据集 Recall@K | 需要真实 embedding 语料 |
| 多机 / 冷缓存基准 | 需要第二台机器与清缓存手段 |
| 真实 CDN / CORS 验收 | 需要实际部署环境 |

### 6.2 设计未定或明确不做

| 项 | 状态 |
| --- | --- |
| ANN 过滤的完整性保证 | 只有显式后过滤，可能少于 topK，已在诊断中标注 |
| 同主版本内的索引格式变更 | 只按主版本判定，无法探测其内部变化 |
| 融合质量需要相关性标注 | k 只做了稳定性测量，未回答哪个 k 排序更好 |
| `.wsql` 压缩算法协商 | 目前只有 gzip；brotli 需要新版本号 |
| JSON 等值过滤 | 需要规范化形式，当前明确拒绝 |
| 时间戳列的源数据推断 | 转换工具把时间一律当字符串；嵌套 JSON 已支持（声明为 `json`） |
| 中文分词 | CJK 逐字，精度换可预测性 |
| 非只读 CTE 的解析 | CTE 后不是只读动词一律拒绝；无法识别的形态 fail-closed（ADR-062） |
| 浏览器 SQL 参数类型 | JSON 绑定，`Date`/二进制/超范围 `bigint` 明确拒绝 |
| 浏览器 SQL 扩展分发 | 必须同源自托管；`extensions.duckdb.org` 无 CORS 头 |
| 浏览器内的大表与冷启动 | 只测了 Node 里的同一 WASM 构建（§5），浏览器内存与 34 MB 首载时间未测 |
| `db.sql()` 的交付方式 | 仍一次性返回数组；增量消费请用 `db.sqlStream()`（Node 与浏览器均为真流式） |


### 6.3 已知问题（未定位）

| 问题 | 证据与现状 |
| --- | --- |
| 偶发测试失败：`@weisql/duckdb-adapter` 的 `maxRows bounds the result instead of truncating` | 1 次全量运行中出现；随后 31 次单文件重复运行与多次全量运行均通过，未能复现。未修改断言，也不再把它当作通过；再次出现时抓完整堆栈与并发状态 |

## 7. 关键决策索引

70 条 ADR 记录在 `docs/DECISION_LOG.md`。与外部读者最相关的是：

| ADR | 决策 |
| --- | --- |
| 016 | Manifest V1 语义与约束 |
| 022 | 精确优先，ANN 必须自报 `exact: false` |
| 026 | 基准装置是测量设备，不是性能承诺 |
| 028 | USearch 度量映射经实测校准 |
| 029 | 索引参数进 Manifest，缺参数拒绝加载 |
| 030 / 043 | ANN 召回必须按分布报告（043 推翻 030 的「均匀最差」判断） |
| 032 / 033 | 全文索引格式、ID Map 与排序规则 |
| 035 | 融合用 RRF，只用排名 |
| 036 | RAG 只做证据组装，不调用模型 |
| 037 | ANN 过滤只提供显式后过滤 |
| 039 | `.wsql` 不压缩、整文件入内存 |
| 040 | Apache-2.0，每个包内自带 LICENSE |
| 057 | Builder 在构建时签名，发布链路少一步补签 |
| 065 / 066 | 浏览器 SQL 用 DuckDB-Wasm、扩展同源自托管；066 用 tokenizer 支持只读 CTE，取代 065 的 `WITH` 拒绝 |
| 063 / 064 | COI 多线程因扩展内存不兼容而不采用；取消只承诺立即停止等待（`engineMayStillRun`） |
| 067 / 068 | 物化预算分单表/整包两层；`maxRows` 超限硬失败并让引擎提前停止 |
| 069 | `sqlStream()` 用 AsyncIterable 增量交付，适配器可选实现并有回退 |

## 8. 发布就绪度

| 检查项 | 状态 |
| --- | --- |
| 测试 / 类型 / 构建 | ✅ 326 测试，typecheck 通过 |
| 打包内容 | ✅ 仅 `dist/` + README + LICENSE，无 src/test 泄漏 |
| 依赖范围 | ✅ caret 且跟踪本地版本 |
| 许可证 | ✅ Apache-2.0（根 + 每包） |
| CI | ✅ 双平台行为闸门 |
| npm 组织与令牌 | ⬜ |
| 多机基准 | ⬜ |

**结论：技术上可发布，行政上未就绪。**

## 9. 建议的下一步（按价值排序）

1. 配置 npm 令牌 → `npm publish --dry-run` 核对五个包 → 正式发布；
2. 在真实 embedding 数据上测 Recall@K，替换 §5.1 的合成数字；
3. 第二台机器复现基准，形成区间而非单点；
4. Playground 接入浏览器 SQL 与混合过滤，并补一条 `probe:playground` 断言；
5. 视需要再做压缩算法协商或源数据的时间戳推断。
