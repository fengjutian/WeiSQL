# WeiSQL AI 测试策略与质量保障规范 V1.7

文档编号：WSAI-QA-001 · 版本：V1.7 · 状态：设计规范草案

## 1. 文档目标

WeiSQL AI 同时涉及 SQL 引擎、向量索引、二进制数据、HTTP Range、WASM 和数据包发布。仅依靠单元测试无法证明整个系统可靠。

本规范建立五层质量保障体系：

### 与当前仓库的差异

本文是**设计规范**，五层体系尚未按本文的工具链落地。当前进度以实现为准：

| 本文的设计 | 当前仓库的实际状态 |
| --- | --- |
| Vitest 作为主测试框架 | 未采用。使用 Node.js 内置 `node --test`，零测试框架依赖 |
| ESLint + Prettier 静态规则 | 未接入。当前只有 `tsc --noEmit` 类型检查 |
| `fast-check` 属性测试、`API Extractor` API 报告 | 未接入 |
| GitHub Actions 编排 L0–L5 门禁 | **仓库没有 `.github/` 目录**。门禁脚本已具备但未接入自动化 |
| `packages/testing` 公共测试工具包 | 未采用。测试代码内聚在各包的 `test/` 目录 |
| Playwright 浏览器集成 | 使用 `playwright-core` 驱动本机 Chromium 的手写探针（`tools/browser-probe`），未引入测试框架 |
| 跨环境一致性测试 | **已实现**：`npm run probe:parity` 逐字段比对 Node 与 Chromium 的查询结果、`exact` 标记与错误码 |
| 损坏数据包与故障注入 | **已实现**：损坏内容、截断资源、缺失文件、非法 JSON 各有独立用例 |
| 性能与内存基准 | **已实现**：`npm run bench` 给出 p50/p95、I/O 字节与峰值内存，`--ann` 额外给出 Recall@K 对照 |
| 发布前产物检查 | **已实现**：`npm run release:check` 校验版本形状、workspace 依赖范围、`files` 清单与 dist 产物 |

已落地的部分覆盖本文 L1–L5 中的大部分场景，但**没有任何一层由 CI 自动触发**——这是本文与仓库现状最大的差距。

### L1

静态质量

类型检查、Lint、依赖与构建检查

### L2

单元测试

距离计算、Manifest、路径和状态机

### L3

集成测试

Parquet、向量文件、ID 映射、索引

### L4

端到端测试

Builder → 发布 → Runtime → 查询

### L5

发布与性能测试

故障恢复、兼容性、延迟、内存和召回率

核心原则：每个重要保证都必须对应可重复执行的测试，而不是只写在文档中。

## 2. 测试范围与优先级

| 优先级 | 测试范围      | 示例               | 发布要求        |
| --- | --------- | ---------------- | ----------- |
| P0  | 数据正确性     | 向量与 SQL 行错位      | 必须通过        |
| P0  | 数据包完整性    | 文件缺失、哈希不一致       | 必须通过        |
| P0  | 安全性       | 路径穿越、恶意 Manifest | 必须通过        |
| P0  | 发布原子性     | 构建失败破坏旧版本        | 必须通过        |
| P1  | SQL 与向量语义 | Node/浏览器结果差异     | 必须通过        |
| P1  | 生命周期      | 重复关闭、关闭后查询       | 必须通过        |
| P1  | 性能基准      | P95、内存、Recall\@K | 达到已批准的门槛    |
| P2  | 大规模压力     | 百万级向量、长时间查询      | 根据发布目标执行    |
| P2  | 故障恢复      | 进程崩溃、磁盘不足、网络中断   | 发布前必须覆盖关键路径 |

## 3. 测试目录规范

```
tests/
├── unit/
│   ├── manifest/
│   ├── resource-reader/
│   ├── vector/
│   ├── builder/
│   └── runtime/
├── integration/
│   ├── parquet/
│   ├── vector-index/
│   ├── id-mapping/
│   └── manifest-validation/
├── e2e/
│   ├── build-and-query.test.ts
│   ├── publish-and-rollback.test.ts
│   └── hybrid-search.test.ts
├── browser/
│   ├── duckdb-wasm.test.ts
│   ├── range-reader.test.ts
│   └── static-deployment.test.ts
├── fault-injection/
│   ├── interrupted-build.test.ts
│   ├── interrupted-publish.test.ts
│   └── corrupted-package.test.ts
├── performance/
│   ├── exact-search.bench.ts
│   ├── ann-search.bench.ts
│   └── resource-reader.bench.ts
└── fixtures/
    ├── valid-package/
    ├── malformed-manifest/
    ├── corrupted-vectors/
    └── mismatched-id-map/
```

测试夹具应尽量小且确定性强。大规模性能数据单独生成，不应随每次普通单元测试一起运行。

## 4. 核心正确性测试

### 4.1 向量距离

对每一种距离度量准备手工可计算的输入，验证数值、排序方向和边界行为。

| 测试输入               | 预期结果          |
| ------------------ | ------------- |
| 完全相同的非零向量，cosine   | 距离为 0         |
| 正交单位向量，cosine      | 距离为 1         |
| 完全相同的向量，L2         | 距离为 0         |
| 单位向量与零向量，cosine    | 按规范拒绝零向量      |
| 向量维度不一致            | 参数错误          |
| 向量含 NaN 或 Infinity | 数据验证失败        |
| 多条记录距离相同           | 按 row ID 稳定排序 |

测试应使用容差比较浮点结果，不能要求不同硬件或不同实现的所有浮点运算都逐位相同。

### 4.2 ID 映射一致性

构造 SQL 数据与向量输入顺序不同的测试：

- SQL 输入顺序：A、B、C。
- 向量输入顺序：C、A、B。
- Builder 通过业务 ID 关联后，应能正确返回 A、B、C 对应的向量和记录。

还必须测试：

- 重复业务 ID；
- 缺失业务 ID；
- 不存在的 `row_id`；
- offsets 数量不正确；
- offsets 最后一项不等于 JSONL 文件长度；
- 64 位偏移超出当前实现可安全处理的范围。

### 4.3 SQL 数据分片

对于分片边界，应验证：

\\[ \sum\_{i=1}^{n}\operatorname{rowCount}\_i =\operatorname{totalRows} \\]

同时检查分片区间连续、无重叠、无遗漏，以及实际 Parquet 行数与 Manifest 声明一致。

## 5. 属性测试与随机测试

除了固定样例，推荐增加属性测试：

- 距离函数对非法维度总是拒绝；
- Top-K 返回数量不超过 K；
- 结果按距离升序、row ID 升序；
- 对同一输入重复查询，结果顺序稳定；
- ID 映射编码后再解码，语义保持一致；
- Manifest 序列化、解析后，关键字段保持一致；
- 文件摘要对任意字节变更都应发生变化（测试中不要求数学上绝对无碰撞，而是验证实现行为）。

随机测试必须记录随机种子。发现问题时，应将失败样本保存为固定回归用例。

## 6. Node 与浏览器一致性

建立同一套公共测试契约，让 Node SQL Adapter、DuckDB-Wasm Adapter 和向量实现运行相同的语义测试。

重点检查：

- SQL 结果类型和空值行为；
- 日期、时间、Decimal 等类型的转换；
- 分页和排序；
- 向量距离和稳定排序；
- 过滤表达式；
- 数据包打开与关闭；
- 缺失能力的错误行为。

不要把所有 SQL 语法都假设为跨引擎一致。应定义 WeiSQL 支持的 SQL 子集，对引擎差异做显式限制和测试。

## 7. 发布与故障注入测试

发布流程是高风险区域，必须模拟失败，而不只是测试正常流程。

| 故障点          | 必须保证           |
| ------------ | -------------- |
| Parquet 写入失败 | 不发布半成品         |
| 向量写入中断       | 不生成可用 Manifest |
| 索引文件损坏       | 验证器拒绝发布        |
| SHA-256 不匹配  | 验证失败           |
| 版本目录已存在      | 拒绝覆盖           |
| 发布时进程退出      | 旧版本仍然可读        |
| 指针更新失败       | 报告明确；不得谎报发布成功  |
| 回滚到不存在的版本    | 拒绝操作           |
| 同时发布相同版本     | 不发生静默覆盖        |
| staging 残留   | 能识别并安全清理       |

每个故障用例都需要验证磁盘状态和 Runtime 的实际可读状态，而不只是检查函数是否抛出异常。

## 8. 性能测试标准

性能测试应分成精确搜索、ANN、资源读取和端到端四组。

| 指标              | 说明               |
| --------------- | ---------------- |
| Build Time      | 数据包和索引构建耗时       |
| Open Time       | Runtime 初始化耗时    |
| P50 / P95       | 查询延迟分位数          |
| Recall\@K       | ANN 结果相对精确搜索的召回率 |
| Peak Memory     | 峰值内存             |
| Package Size    | 数据包总体积及分项大小      |
| Cache Hit Rate  | 资源缓存命中率          |
| Range Requests  | HTTP 分段读取次数      |
| Validation Time | 完整校验耗时           |

### 8.1 ANN 召回率

对查询集合 \\(Q\\)，令精确搜索得到的 Top-K 为 \\(G_K(q)\\)，ANN 得到的结果为 \\(A_K(q)\\)。可采用：

\\[ \operatorname{Recall\@K} = \frac{1}{|Q|} \sum\_{q\in Q} \frac{|A_K(q)\cap G_K(q)|}{K} \\]

测试时需要明确：若某条查询的有效候选数少于 K，分母应使用实际可返回的有效结果数，或者在测试数据构造时保证每条查询至少有 K 条有效候选。两种策略必须统一。

V1 不应在缺少真实基准数据时承诺固定的毫秒级延迟或固定召回率。应先在目标硬件上生成基线，再把通过评审的数值写入发布门槛。

## 9. CI 流水线

建议设置四类任务：

1. Pull Request 快速检查：Lint、类型检查、单元测试、Manifest 校验。
2. 主分支集成检查：Parquet、向量索引、Runtime 和发布测试。
3. 夜间性能任务：较大数据集、Recall\@K、内存和延迟。
4. 发布候选任务：全量测试、依赖审计、打包验证、浏览器静态部署测试。

建议初始命令：

```
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
```

这些命令需要与实际 `package.json` 脚本保持一致。浏览器测试和性能测试可独立设置脚本，避免普通 PR 因大规模基准任务而过慢。

## 10. 发布质量门禁

正式发布前必须满足：

- 所有 P0 测试通过。
- 所有公开 API 均有自动化测试。
- SQL 数据、向量和 ID 映射完全一致。
- Manifest、文件长度与 SHA-256 验证通过。
- Node Runtime 端到端测试通过。
- 浏览器 Runtime 端到端测试通过。
- 关键故障注入测试通过。
- ANN 的 Recall\@K 达到批准门槛。
- 性能报告记录硬件、依赖版本和数据规模。
- 已知问题、兼容性限制和升级策略已记录。
- 发布失败和回滚流程已验证。

## 11. 下一步文档

建议下一份编写：

《WeiSQL AI 数据包格式与 Manifest 正式规范 V1.8》

原因是 V1.5 已给出 Manifest 示例，但仍需要冻结字段、JSON Schema、格式版本兼容策略、文件清单唯一性、向量集合定义和签名扩展边界。先锁定这些内容，后续 Builder、Runtime 和测试夹具才有稳定的共同契约。

目前 V1.7 仍是质量保障设计草案；下一阶段应将它与实际仓库和 CI 对齐，再逐项标记为“已实现、已测试、未实现”，避免把计划误当作已交付功能。

