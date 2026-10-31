---
title: 架构
description: WeiSQL 的分层、一次查询的完整链路、信任边界与三种部署形态。
sidebar_position: 13
---

WeiSQL 的核心设计只有一句话：**把“数据库服务”换成“可版本化的静态数据包 + 一层只读 Runtime”**。理解这一点，后面的 Adapter、缓存、完整性校验都是它的推论。

## 1. 分层

```text
┌─────────────────────────────────────────────────────────┐
│ 应用层   浏览器应用 / Node 服务 / Playground / CLI        │
├─────────────────────────────────────────────────────────┤
│ API 层   open() → WeiSQLDatabase                         │
│          sql · vector · text · hybrid · rag · close      │
├─────────────────────────────────────────────────────────┤
│ 校验层   L1/L2 Manifest 校验 · L3 资源完整性 · L4 列比对  │
├─────────────────────────────────────────────────────────┤
│ 查询层   精确向量 · BM25 · RRF 融合 · RAG · SQL 委派      │
├─────────────────────────────────────────────────────────┤
│ 适配层   SqlAdapter（DuckDB / DuckDB-Wasm）              │
│          VectorAdapter（TypeScript 精确 / USearch ANN）  │
├─────────────────────────────────────────────────────────┤
│ 资源层   ResourceReader（HTTP / Node 文件 / .wsql 容器）  │
│          CachedResourceReader（LRU + 并发合并）           │
├─────────────────────────────────────────────────────────┤
│ 存储层   数据包目录（CDN / 磁盘）或单个 .wsql 文件        │
└─────────────────────────────────────────────────────────┘
```

两个方向都是单向依赖：

- **向下**：上层只依赖接口，不依赖具体引擎。SDK 本身没有 DuckDB、USearch 的运行时依赖。
- **向上**：Adapter 通过 `open({ sqlAdapter, vectorAdapter })` 注入，能力通过 `capabilities()` 如实上报。

## 2. 一次向量查询发生了什么

以默认的 `exact-filter-first` 策略为例：

```text
vector.search(name, query, { topK, filter })
  │
  ├─ 1. 校验参数：维度、topK、filter 列是否在 Manifest 中声明
  ├─ 2. 有 filter？→ 编译为参数绑定 SQL，由 SqlAdapter 求出允许的业务 ID 集合
  ├─ 3. 业务 ID → 向量行号
  │      优先用持久化 id→row 索引；否则扫描 ID Map
  ├─ 4. 按行号读取向量块（连续行合并，Float32 LE 解码）
  ├─ 5. 逐条计算距离（Cosine / L2 / IP），维护固定容量最大堆
  ├─ 6. 只对最终 Top-K 解析回业务 ID
  └─ 7. 返回 hits + diagnostics（backend、exact、耗时、候选数）
```

几个容易被忽略的点：

- **过滤发生在 Top-K 之前**，所以结果仍是过滤子集上的严格最近 K，`exact: true` 才站得住。
- **窄过滤只读允许行**：允许行不超过集合的 1/8 时按连续段合并读取，否则顺序扫描。两条路径都有测试验证读取量。
- **分块降低峰值内存，但不减少总 I/O 与计算量**。精确检索依旧是 O(N) 扫描，这是 V1 的明确取舍。
- `vector-first` 先取有界候选窗口再过滤，只有在窗口覆盖整个集合时才可能 `exact: true`（靠穷尽，而非靠构造）。

## 3. SQL 查询链路

SQL 由 Adapter 执行，Runtime 只负责编排与校验：

```text
db.sql(query, params)        // 一次性数组
db.sqlStream(query, params)  // 分批异步迭代
  ├─ Adapter.prepare()  → 语句分类必须是 SELECT / EXPLAIN
  ├─ 参数通过预处理语句绑定（拒绝插值）
  ├─ 执行，结果映射为普通对象
  └─ 取消：Node 为 native interrupt；浏览器为 best-effort
```

Adapter 打开时会做三件事：从 `ResourceReader` 读表字节、按 Manifest 比对列定义（L4）、把表加载到引擎。Node 端默认 `memory` 模式，物化后关闭外部文件访问；`lazy` 模式保留外部访问，只适合由应用作者编写 SQL 的场景。

## 4. 信任边界

Manifest 和所有远程资源都按**不可信输入**处理：

| 边界 | 措施 |
| --- | --- |
| 路径 | 规范化后再 I/O；拒绝绝对路径、`..`、反斜杠、URL scheme、重复规范路径 |
| 传输 | HTTP 只接受 `206` + 匹配的 `Content-Range`；短读、超长、取消都不进入缓存 |
| 内容 | L3 用声明尺寸与 SHA-256 检测损坏；签名用于发布者身份，二者不是一回事 |
| SQL | 只读语句分类、参数绑定、单语句、关闭外部文件访问（`memory` 模式） |
| 数据本身 | 静态包默认可被下载，不得放入密钥、令牌或私密数据 |

需要强调的是：**SHA-256 证明“内容与 Manifest 一致”，不证明“发布者可信”**。后者要靠 Ed25519 签名与信任固定。

## 5. 三种部署形态

| 形态 | 读取方式 | 适用 | 代价 |
| --- | --- | --- | --- |
| 目录 + CDN | 每个资源独立 HTTP Range | 资源多、按需读取、可缓存 | 需要正确配置 Range/CORS；文件多 |
| 单文件 `.wsql` | 整包下载，或流式只读头部 + 文件 Range | 单对象发布、原子替换 | 整包模式占内存；压缩条目 Range 需先解压 |
| Node 本地目录 | 文件句柄 + 精确偏移 | 构建、测试、离线工具 | 需要文件系统权限与包根 containment |

三种形态对上层 API 完全一致，因为它们都实现同一个 `ResourceReader` 契约。

## 6. 设计原则

1. **显式失败，不伪造结果**：没有 Reader 返回 `INDEX_NOT_FOUND`，没有 SQL Adapter 返回 `SQL_UNSUPPORTED`，不返回空数组假装成功。
2. **Adapter 注入，SDK 零引擎依赖**：浏览器与 Node 可以选不同引擎，能力差异通过 `capabilities()` 暴露。
3. **精确优先**：ANN 必须自报 `exact: false`；后过滤必须自报 `postFiltered: true`。
4. **测量先于承诺**：基准装置是测量设备，不是性能承诺；召回数字必须连同数据分布一起报告。
5. **发布不可变**：缓存按发布版本身份隔离；换版本即失效，避免新旧资源混用。

## 7. 为什么还有一个 Rust crate

`crates/vector-benchmark` 是**确定性精确 Cosine 基线**，用于对照 TypeScript 实现的正确性与性能，不进入运行时，也不是生产 ANN 引擎。它的存在是为了让“TS 实现算得对不对”有一个独立参照，而不是为了把核心逻辑搬到 Rust。

延伸阅读：[总体技术规范](https://github.com/fengjutian/WeiSQL/blob/main/docs/TECHNICAL_SPEC_V1.md)、[Runtime 兼容性](https://github.com/fengjutian/WeiSQL/blob/main/docs/RUNTIME_COMPATIBILITY.md)、[向量搜索核心一致性](https://github.com/fengjutian/WeiSQL/blob/main/docs/VECTOR_SEARCH_CORE_CONSISTENCY_SPEC_V1_4.md)。
