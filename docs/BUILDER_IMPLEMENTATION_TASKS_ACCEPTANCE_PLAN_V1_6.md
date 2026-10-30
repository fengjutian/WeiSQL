# WeiSQL AI Builder 实施任务拆分与验收计划 V1.6

文档编号：WSAI-PLAN-001 · 版本：V1.6 · 状态：工程实施计划草案 · 适用阶段：V1 首版

本文将 WeiSQL AI V0.9–V1.5 的设计规范转化为可执行的研发任务，明确项目目录、包职责、实现顺序、接口契约、测试命令、交付物和验收门槛。

本阶段目标不是继续堆叠设计文档，而是建立一条能够真实运行的端到端链路：

输入 JSONL → 规范化 → 生成 Parquet → 导入向量 → 构建索引 → 生成 Manifest → 完整验证 → 发布数据包 → Runtime 打开并查询。

目前以下内容是实施计划，不代表代码已创建、命令已运行或测试已通过。

### 与当前仓库的差异

本文是**实施计划草案**，任务清单未按本文执行。实际落地情况：

| 本文计划的任务 | 当前状态 |
| --- | --- |
| 交付物 A：Builder CLI | 部分实现。`buildPackage()` 是 SDK API，**未做成独立 CLI**；只有 `weisql validate` 一个校验子命令 |
| JSONL 规范化 → 生成 Parquet | 未实现。`examples/source/documents.parquet` 由 `tools/make-source-parquet.py`（依赖 pyarrow）生成，属于不可变输入 |
| 构建向量索引 | 未实现（Manifest `index` 字段缺 connectivity / expansion 等构建参数） |
| 生成 Manifest + 完整验证 + 发布 | 已实现：真实 Float32、ID Map、真实 SHA-256 与字节数，暂存区自检后原子发布，失败清理暂存区 |
| 交付物 C：可验证 Runtime | 已实现：`open()` → `sql()` / `vector.search()` / `text.search()` 全链路可跑 |
| 主键交叉校验 | 部分实现：未提供 `rowIds` 时如实报告 `id-membership-unverified` 警告，不假装已校验 |
| 独立的 Builder 包 | 未采用。`buildPackage()` 在 `@weisql/sdk` 内 |

本文的**验收门槛**思路已被实际采纳：退出码即闸门（`weisql validate` 返回 0/1/2）、发布前静态检查（`npm run release:check`）。

## 1. V1 首版交付目标

交付物 A：Builder CLI

使用 TypeScript 实现可重复执行的数据构建、验证、发布与报告生成。

交付物 B：标准数据包

Parquet、Float32 向量、ID 映射、可选 ANN 索引和 Manifest 具备一致性保证。

交付物 C：可验证 Runtime

能够打开正式发布的数据包，执行 SQL 和向量查询，并正确关闭资源。

交付物 D：自动化测试

覆盖格式、数据对齐、损坏文件、路径安全、发布失败、回滚和查询正确性。

### 1.1 V1 功能边界

| 功能              | V1 要求              | 验收方式                       |
| --------------- | ------------------ | -------------------------- |
| JSONL 导入        | 必须                 | 自动化集成测试                    |
| CSV 导入          | 必须                 | 自动化集成测试                    |
| Parquet 输入      | 适配器预留；可列为后续扩展      | 单独确认排期                     |
| Parquet 输出      | 必须                 | 使用目标 SQL 引擎重新读取            |
| 外部 Embedding 导入 | 必须                 | 维度、ID、数值验证                 |
| 精确向量搜索          | 必须                 | 与暴力搜索基准比对                  |
| ANN 索引          | 首选 USearch，实际绑定后验收 | 索引加载及召回率测试                 |
| SQL 查询          | 必须                 | DuckDB / DuckDB-Wasm 适配器测试 |
| 混合检索            | 必须提供受限版本           | 过滤语义与结果关联测试                |
| Manifest 校验     | 必须                 | 正反向文件一致性测试                 |
| 本地版本发布          | 必须                 | 故障注入及回滚测试                  |
| 浏览器静态托管         | 运行时目标              | 浏览器与 HTTP Range 测试         |
| 在线数据写入          | 不支持                | 不属于 V1                     |
| 分布式构建           | 不支持                | 后续版本评估                     |

关键约束： 精确向量搜索是正确性基线；ANN 是性能优化。即使 ANN 适配器暂时未完成，Builder 的数据包构建、Manifest 校验和 SQL 查询也应能独立验证。

## 2. 仓库结构与包职责

建议使用 `pnpm workspace + TypeScript + Vitest` 管理 TS 包。Rust crate 独立构建，避免首阶段引入不必要的跨语言复杂度。

```
weisql-ai/
├── apps/
│   ├── playground/              # React + TypeScript 演示应用
│   └── docs/                     # 文档站
├── packages/
│   ├── core/                     # 公共类型、错误、能力定义
│   ├── manifest/                 # Manifest Schema 与校验
│   ├── resource-reader/          # 本地文件与 HTTP Range
│   ├── vector/                   # 距离计算、精确搜索、Top-K
│   ├── sql-duckdb/               # Node SQL 适配器
│   ├── sql-duckdb-wasm/          # 浏览器 SQL 适配器
│   ├── vector-usearch/           # ANN 适配器
│   ├── runtime/                  # open/sql/vector/hybrid/close
│   ├── builder/                  # CLI、导入、索引、发布
│   └── testing/                  # 公共测试夹具与一致性测试
├── crates/
│   └── weisql-core/              # 后续 Rust 核心实现
├── fixtures/
│   ├── valid-package/
│   └── invalid-packages/
├── tests/
│   ├── integration/
│   ├── e2e/
│   └── fault-injection/
├── docs/
│   ├── requirements/
│   ├── architecture/
│   ├── api/
│   ├── implementation/
│   └── decisions/
├── scripts/
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
└── vitest.workspace.ts
```

### 2.1 包依赖约束

core / manifest

公共类型、格式和错误语义

resource-reader / vector / SQL adapters

文件读取、算法、引擎适配

runtime

只读查询编排

builder

数据构建与发布

依赖方向必须保持单向：

- `core` 不依赖 Runtime 或 Builder。
- `manifest` 依赖 `core`，不依赖 SQL 引擎。
- `vector` 不依赖 USearch 的内部类型。
- `runtime` 通过适配器接口访问 SQL 和向量后端。
- `builder` 通过独立的 Writer、Index Adapter 和 Publisher 接口构建数据包。
- Playground 不直接访问底层索引文件，也不负责数据完整性校验。

## 3. 研发里程碑

采用按依赖顺序推进的阶段计划。下表是建议的开发节奏，不是已完成进度。

| 阶段 | 重点          | 主要产出                          | 通过门槛               |
| -- | ----------- | ----------------------------- | ------------------ |
| M0 | 工程骨架        | Workspace、TS 配置、CI            | 所有包可构建             |
| M1 | 公共契约        | 类型、错误、Manifest Schema         | Schema 测试通过        |
| M2 | 资源层         | Node Reader、HTTP Range Reader | 边界和安全测试通过          |
| M3 | 向量基础        | 距离、精确搜索、Top-K                 | 与参考实现一致            |
| M4 | 数据构建        | 规范化、Parquet、ID 映射             | 跨文件校验通过            |
| M5 | 索引与 Runtime | SQL、ANN、统一查询 API              | E2E 查询通过           |
| M6 | 发布与恢复       | Staging、版本发布、回滚               | 故障注入通过             |
| M7 | 浏览器验证       | DuckDB-Wasm、HTTP Range        | 真实浏览器测试通过          |
| M8 | 发布候选        | 性能、文档、包发布检查                   | 全部 Release Gate 通过 |

推荐顺序是先实现 M0–M4 的正确性链路，再引入 ANN 优化；Rust 核心和 UI 演示不应阻塞最小可运行的数据包。

## 4. M0：工程骨架与 CI

### 4.1 任务拆分

- `M0-01` 初始化 Git 仓库和 pnpm workspace。
- `M0-02` 建立 TypeScript strict 配置。
- `M0-03` 为每个包设置独立 `package.json` 和导出入口。
- `M0-04` 配置 Vitest。
- `M0-05` 配置 ESLint、格式检查与类型检查。
- `M0-06` 配置 CI 执行安装、Lint、类型检查和测试。
- `M0-07` 增加变更日志与版本策略。

### 4.2 根目录脚本建议

```
{
  "private": true,
  "packageManager": "pnpm@<pinned-version>",
  "scripts": {
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint",
    "test": "pnpm -r test",
    "test:integration": "vitest run tests/integration",
    "test:e2e": "vitest run tests/e2e",
    "check": "pnpm lint && pnpm typecheck && pnpm test"
  }
}
```

`<pinned-version>` 是占位符；实际仓库应锁定已验证的 pnpm 版本，并提交 `pnpm-lock.yaml`。根脚本还应根据具体包的构建工具配置调整，不能直接假定所有包都已经具备 `build`、`lint` 等脚本。

### 4.3 M0 验收

- 全新克隆后能按 README 完成依赖安装。
- `pnpm-lock.yaml` 已提交。
- TypeScript strict 模式生效。
- 任一包失败会让整体 CI 失败。
- 不允许用 `|| true` 隐藏测试错误。
- Rust 工具链不是 TS 最小构建的强制前置条件。

## 5. M1：公共类型、错误与 Manifest

### 5.1 任务拆分

| 任务    | 文件或模块                       | 具体要求               |
| ----- | --------------------------- | ------------------ |
| M1-01 | `core/errors.ts`            | 定义稳定错误码及上下文        |
| M1-02 | `core/capabilities.ts`      | 定义运行时能力声明          |
| M1-03 | `core/database.ts`          | 定义公共 Runtime 接口    |
| M1-04 | `manifest/schema.ts`        | 定义 Manifest Schema |
| M1-05 | `manifest/validate.ts`      | 校验必填字段和跨字段规则       |
| M1-06 | `manifest/paths.ts`         | 路径安全与规范化           |
| M1-07 | `manifest/files.ts`         | 文件清单引用与摘要字段        |
| M1-08 | `manifest/compatibility.ts` | 格式版本和后端兼容检查        |

### 5.2 必须区分的校验

Manifest 验证至少分为：

1. 结构验证：JSON 形状、类型、枚举、必填字段。
2. 语义验证：维度大于零、行数非负、分片区间连续。
3. 资源验证：引用路径安全、文件存在、长度和摘要一致。
4. 后端兼容验证：索引后端及版本是否支持。
5. 可信性验证：若未来引入签名，另行检查签名和可信密钥。

结构验证成功不能直接把数据包标记为完整有效。

### 5.3 M1 验收

- 合法 Manifest 可以通过。
- 缺失字段、非法类型、未知必需字段和无效版本按契约处理。
- 目录穿越路径被拒绝。
- 文件引用缺失不会被忽略。
- 格式版本与数据集版本独立。
- 错误码可由测试稳定断言。

## 6. M2：资源读取层

本阶段落实 V1.3 规范。

### 6.1 接口建议

```
export interface ResourceStat {
  sizeBytes: number;
  etag?: string;
  lastModified?: string;
}

export interface ResourceReader {
  stat(path: string): Promise<ResourceStat>;
  readRange(
    path: string,
    offset: number,
    length: number
  ): Promise<Uint8Array>;
  close(): Promise<void>;
}
```

实际实现需要进一步规定：`offset` 和 `length` 是否接受安全整数、零长度区间语义、文件结束边界、最大请求长度、并发限制及关闭后的行为。

### 6.2 实现顺序

1. 编写 `MemoryResourceReader`，作为确定性测试工具。
2. 实现 `NodeFileReader`。
3. 实现 `HttpRangeReader`。
4. 实现统一的路径安全校验。
5. 实现有界并发和 LRU 缓存。
6. 增加 ETag、Last-Modified 与不可变版本缓存策略。
7. 验证 HTTP Range 的 `206`、`Content-Range` 和实际字节长度。
8. 验证服务器返回 `200` 且忽略 Range 时，按规范失败。

### 6.3 验收矩阵

| 测试                      | 预期                      |
| ----------------------- | ----------------------- |
| 读取文件开头、中间和结尾            | 字节完全正确                  |
| 读取零长度区间                 | 返回空数组                   |
| 越界或非安全整数                | 返回稳定参数错误                |
| HTTP 返回错误 Content-Range | 失败                      |
| HTTP 返回 200 全量文件        | 默认报 `RANGE_UNSUPPORTED` |
| 并发超过限制                  | 排队或按契约拒绝                |
| close 后读取               | 明确失败                    |
| 路径穿越与符号链接逃逸             | 拒绝访问                    |

缓存容量 64 MiB、并发 8、单次 Range 最大 8 MiB 可作为初始配置，但应在浏览器与 Node 测试中验证后才冻结。

## 7. M3：向量算法基础

### 7.1 必做模块

```
packages/vector/src/
├── types.ts
├── validate-vector.ts
├── distance.ts
├── float32-reader.ts
├── top-k-heap.ts
├── exact-search.ts
├── id-map-reader.ts
└── group-rows.ts
```

### 7.2 任务

- `M3-01` 实现 cosine、L2、IP 距离函数。
- `M3-02` 定义有限值、维度与零向量验证。
- `M3-03` 实现小端 Float32 Reader。
- `M3-04` 实现稳定排序规则：距离升序，再按 row ID 升序。
- `M3-05` 实现 Top-K 最大堆。
- `M3-06` 实现 exact search。
- `M3-07` 实现 ID map 与 offsets Reader。
- `M3-08` 建立参考暴力搜索实现，用于测试算法交叉验证。

### 7.3 正确性验收

- 小型确定性数据集的 top-K 与参考实现完全一致。
- 所有度量的排序方向正确。
- cosine 零向量按规范拒绝。
- NaN、Infinity、错误维度和非法 K 被拒绝。
- 并列距离时排序稳定。
- 不读取越界向量行。
- Float32 解码结果与已知字节样例一致。
- 数值极端值不会产生未被发现的 NaN 排序结果。

对于浮点累加，应专门测试平方溢出、范数溢出和相近向量的排序误差。不要仅用随机的普通量级数据证明算法正确。

## 8. M4：Builder 数据构建

这是首版的关键阶段。

### 8.1 任务拆分

| 编号    | 模块                  | 实施内容              | 验收条件            |
| ----- | ------------------- | ----------------- | --------------- |
| M4-01 | `source-adapters`   | JSONL Reader      | 正确解析并报告无效行      |
| M4-02 | `source-adapters`   | CSV Reader        | 编码、表头、引号、空值处理正确 |
| M4-03 | `normalizer`        | 字段类型、主键与稳定 row ID | 记录数和 ID 唯一      |
| M4-04 | `parquet-writer`    | 分片写入              | 分片可重新读取         |
| M4-05 | `vector-ingest`     | 外部向量读取与验证         | 维度、ID、数值正确      |
| M4-06 | `id-map-builder`    | JSONL 与 offsets   | 边界、数量和映射正确      |
| M4-07 | `index-adapters`    | 精确搜索索引或 USearch   | 索引可重新加载         |
| M4-08 | `manifest-writer`   | 汇总数据包描述           | 引用与实际文件一致       |
| M4-09 | `package-validator` | 完整数据包验证           | 所有强制校验通过        |
| M4-10 | `build-journal`     | 阶段日志和失败报告         | 可以定位失败阶段        |

### 8.2 内部中间产物

在 staging 目录中建议使用独立工作目录：

```
.staging/<buildId>/
├── input-snapshot.json
├── normalized/
│   ├── records.jsonl
│   └── row-directory.jsonl
├── data/
├── vectors/
├── indexes/
├── metadata/
│   ├── build-info.json
│   └── validation-report.json
└── manifest.json
```

这些只是建议布局。`normalized/` 下的完整中间数据可能很大，不能默认全部加载到内存；应允许流式处理和按分片落盘。最终发布时，只复制或移动正式数据包需要的文件。

### 8.3 构建接口

```
export interface BuildRequest {
  configPath: string;
  outputDirectory: string;
  buildId?: string;
}

export interface BuildResult {
  buildId: string;
  datasetId: string;
  datasetVersion: string;
  manifestPath: string;
  fileCount: number;
  tableCount: number;
  vectorCollectionCount: number;
  validationPassed: boolean;
}

export interface BuildService {
  build(request: BuildRequest): Promise<BuildResult>;
}
```

正式实现还需定义取消信号、日志接口、阶段进度、失败结果和退出码。对于 CLI，构建失败必须返回非零退出码。

### 8.4 M4 验收场景

1. 正常数据完整构建。
2. 重复主键导致失败。
3. 向量缺少业务 ID。
4. 向量维度不一致。
5. SQL 数据与向量数据记录顺序不同，但通过 ID 映射正确关联。
6. Parquet 写入中断。
7. 索引构建中断。
8. Manifest 引用了不存在的文件。
9. 文件字节被篡改。
10. 构建器重复执行相同配置。
11. 同一数据集使用不同版本号。
12. 大数据集构建不需要将全部向量一次性放入内存。

## 9. M5：Runtime、SQL 和向量适配器

### 9.1 实施优先级

1. 定义 `SqlAdapter` 和 `VectorAdapter` 的公共契约。
2. 使用 Memory Adapter 建立 Runtime 生命周期测试。
3. 接入 DuckDB Node SQL Adapter。
4. 接入向量精确搜索。
5. 实现 `open()`、`sql()`、`vector.search()`、`hybrid.search()`、`close()`。
6. 接入 USearch Adapter。
7. 单独接入 DuckDB-Wasm。
8. 浏览器侧验证 Range、WASM 内存和真实静态部署。

### 9.2 Runtime 最小接口

```
export interface WeiSQLDatabase {
  sql(
    query: string,
    options?: { limit?: number }
  ): Promise<unknown>;

  vector: {
    search(request: {
      collection: string;
      vector: Float32Array;
      topK: number;
      metric?: "cosine" | "l2" | "ip";
    }): Promise<unknown>;
  };

  close(): Promise<void>;
}
```

这是示意性接口，不应直接替代 V1.0 API Contract 中已经定义的结果类型、分页、流式查询、过滤条件、能力声明和错误类型。

### 9.3 必须验证的运行时语义

- `open()` 失败时释放已创建的资源。
- `close()` 幂等。
- 进入 `CLOSING` 后拒绝新查询。
- 关闭后的查询返回稳定错误。
- 向量结果中的 ID 能关联回 SQL 数据。
- ANN 的 `exact` 标记不能误报。
- 缺少后端适配器时明确报告不支持。
- 不把后端私有类型泄露到公共 SDK。
- 浏览器与 Node 的查询语义尽可能一致。

## 10. M6：发布器与版本管理

### 10.1 任务

- `M6-01` 实现 staging 生命周期。
- `M6-02` 发布前执行 `full` 验证。
- `M6-03` 实现不可变版本目录。
- `M6-04` 拒绝覆盖已有版本。
- `M6-05` 在同一文件系统支持时使用原子重命名。
- `M6-06` 实现可选 `stable.json` 指针更新。
- `M6-07` 实现回滚命令。
- `M6-08` 实现并发发布冲突处理。
- `M6-09` 实现崩溃后的 staging 清理。
- `M6-10` 为发布过程增加故障注入测试。

### 10.2 CLI 命令草案

```
# 构建数据包
pnpm weisql build --config weisql.config.json

# 验证数据包
pnpm weisql validate ./dist/docs-dataset/2026-10-30.1

# 查看包信息
pnpm weisql inspect ./dist/docs-dataset/2026-10-30.1

# 发布不可变版本
pnpm weisql publish ./dist/docs-dataset/2026-10-30.1

# 回滚版本指针
pnpm weisql rollback \
  --dataset docs-dataset \
  --version 2026-10-30.1
```

命令名称、参数和实际入口文件需要在 CLI 实现中锁定。不能在未实现前把这些命令描述为已经可用。

### 10.3 发布故障注入

在以下位置模拟进程退出或 I/O 失败：

- Parquet 写入期间；
- 向量文件写入期间；
- ANN 索引写入期间；
- Manifest 生成期间；
- 完整校验期间；
- staging 到最终目录移动期间；
- 版本指针更新期间。

验收目标：任何失败都不能让不完整版本成为可用版本，也不能破坏之前的有效版本。

## 11. M7：浏览器与静态托管验证

浏览器端不是简单地把 Node 版本打包一下。它涉及 WASM 初始化、内存限制、跨域请求和资源分块。

### 11.1 测试环境

- 本地 HTTP 静态服务器；
- Netlify Preview 或等效预览环境；
- HTTPS；
- 开启 Range 的服务器；
- 忽略 Range 的对照服务器；
- 正确配置和错误配置的 CORS；
- 冷缓存与热缓存；
- Chrome/Edge 至少一个真实浏览器版本。

### 11.2 验收矩阵

| 项目       | 通过条件                       |
| -------- | -------------------------- |
| WASM 加载  | 成功初始化，无阻塞 UI 的同步重任务        |
| Range 读取 | 正确处理 206 与 Content-Range   |
| CORS     | 能读取所需响应头和数据                |
| 缓存       | 同一不可变版本的重复读取能合理复用          |
| 内存       | 大数据集查询不要求将所有数据预加载到 JS 内存   |
| SQL      | 真实 Parquet 查询成功            |
| 向量       | top-K 结果正确，映射无错            |
| 关闭       | Runtime 关闭后释放可释放资源         |
| 发布       | 通过实际部署 URL 打开成功            |
| 错误诊断     | Range/CORS/WASM 错误能定位到明确原因 |

对于浏览器 WASM 和本地原生后端，应分别生成测试报告，不能用 Node 测试通过代替浏览器验收。

## 12. M8：性能与发布候选

### 12.1 性能基准矩阵

| 规模   | 向量维度 | 原始向量大小（十进制） | 目的            |
| ---- | ---- | ----------- | ------------- |
| 100K | 768  | 307.2 MB    | 正确性和基线        |
| 500K | 768  | 1.536 GB    | 中等规模内存与索引测试   |
| 1M   | 768  | 3.072 GB    | 大规模构建、磁盘和读取测试 |

以上仅是原始向量文件大小，未包括索引、Parquet、映射、临时文件及运行时开销。浏览器测试应另选适合目标设备的内存规模，不能要求每台设备一次性装入 1M 向量。

### 12.2 必须输出的报告

- 构建耗时；
- Parquet、向量、索引和映射文件大小；
- Runtime 初始化时间；
- SQL 查询 P50/P95；
- 向量搜索 P50/P95；
- Recall\@K；
- 峰值 RSS 或可测得的浏览器内存指标；
- Range 请求数量；
- 缓存命中率；
- 完整性校验耗时；
- Native 与 WASM 的一致性差异。

### 12.3 Release Gate

正式发布前必须全部满足：

- `pnpm install --frozen-lockfile` 成功。
- Lint 通过。
- TypeScript 类型检查通过。
- 单元测试通过。
- 集成测试通过。
- E2E 测试通过。
- Manifest 与数据包完整性检查通过。
- 精确向量搜索与参考实现一致。
- ANN 召回率达到预先声明的门槛。
- Node Runtime 查询通过。
- 浏览器 Runtime 查询通过。
- 发布故障注入测试通过。
- 回滚测试通过。
- 文档中的命令与真实实现一致。
- 所有已知限制均已记录。

ANN 的 Recall\@K 阈值和 P95 延迟阈值应在明确硬件与测试环境后设定，不应先写一个没有依据的性能数字，再反过来声称实现满足它。

## 13. 推荐开发顺序与风险控制

### 13.1 第一条端到端路径

建议先实现以下最小闭环：

1. 创建 monorepo、类型检查和测试骨架。
2. 实现 Manifest Schema、路径校验和 Memory Resource Reader。
3. 实现 JSONL → Parquet 的最小构建流程。
4. 实现向量 Float32 文件、ID 映射与精确搜索。
5. 实现 Manifest 生成、SHA-256 校验和包验证。
6. 实现 Runtime 打开数据包并执行 SQL 和向量搜索。
7. 实现不可变版本发布和失败恢复。
8. 最后接入 ANN 和浏览器 WASM，进行独立验收。

### 13.2 主要风险

| 风险                          | 影响                | 控制措施                |
| --------------------------- | ----------------- | ------------------- |
| DuckDB 与 DuckDB-Wasm API 差异 | Node/浏览器行为不一致     | 统一 Adapter 契约与一致性测试 |
| ANN 后端版本差异                  | 索引无法加载            | 固定后端版本并记录元数据        |
| 行 ID 错位                     | 检索结果对应错误业务数据      | 稳定 row ID、显式映射、交叉校验 |
| 全量加载导致内存爆炸                  | 浏览器或 Node 崩溃      | 分块读取、流式构建、内存基准      |
| 发布半成品                       | Runtime 打开失败      | staging、完整校验、不可变发布  |
| 路径穿越                        | 读取数据包外部文件         | 多层路径验证和真实路径约束       |
| 缓存混合版本                      | Manifest 与数据文件不匹配 | 不可变 URL 和版本化缓存键     |
| 设计未与真实 API 对齐               | 接口无法编译或执行         | 先验证最小原型，再冻结接口       |

## 14. 开发任务跟踪表

下面是一份可以用于后续研发推进的任务清单。勾选仅表示你可以在此界面标记计划状态，不会自动修改 Git 仓库或执行代码。

## 研发任务面板

0/9 项标记完成

M0 · 工程骨架与 CI

pnpm workspace、TS strict、Vitest、CI

M1 · 公共类型与 Manifest

类型、错误码、Schema、路径校验

M2 · 资源读取层

Memory / Node / HTTP Range Reader

M3 · 向量核心

距离、Float32、Top-K、精确搜索

M4 · Builder 数据管线

JSONL/CSV、Parquet、ID 映射、Manifest

M5 · Runtime 与 SQL

DuckDB、Runtime 生命周期、向量查询

M6 · 发布与恢复

staging、不可变版本、回滚、故障注入

M7 · 浏览器验证

DuckDB-Wasm、Range、CORS、静态部署

M8 · 性能与 Release Gate

基准报告、回归测试、发布候选

复制任务清单

## 15. 最终建议

WeiSQL AI 的首版应优先验证三个核心问题：

1. 数据是否正确： SQL 记录、向量、ID 映射与索引之间没有错位。
2. 数据包是否可靠： Manifest、哈希、文件引用和发布过程能够抵抗常见故障。
3. Runtime 是否可用： Node 和浏览器能够读取同一数据包，并在契约范围内返回一致的查询语义。

因此，下一步最值得做的不是立即开发 Playground UI，也不是优先移植 Rust，而是进入 M0–M4 的实际工程实现，先做出一条能够构建、验证并重新读取的小型数据包闭环。

接下来可以按这一计划逐个创建真实文件，优先实现 `packages/core`、`packages/manifest`、`packages/vector` 和 Builder 的最小可运行版本，再通过测试逐步接入 Parquet、SQL 和 ANN。

