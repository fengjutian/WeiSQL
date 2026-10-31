---
title: 核心概念
description: 用一张分层图讲清数据包、Manifest、L1–L4 校验，以及 Runtime、Adapter 与 Reader 的分工。
sidebar_position: 12
---

这一页只做一件事：给你一个能长期用下去的心智模型。读完你应该能回答“某个问题该归哪一层负责”，而不是记住一堆 API 名字。

## 三个概念先记住

1. **数据包**：一组不可变的静态字节。它是发布单元，也是缓存与完整性校验的单位。
2. **Manifest**：数据包的目录与说明书。它声明有哪些表、哪些向量集合、每个文件多大、摘要是什么。
3. **Runtime**：`open()` 返回的只读对象。它把“字节 + 说明”变成一个可查询的数据库视图。

其余的 Reader、Adapter、缓存、索引，都是这三者之间的连接件。

## 分层图

```text
[你的应用]  db.sql() / db.vector.search() / db.text.search()
            db.hybrid.search() / db.rag.search()
   │
   ▼
[Runtime]   只读生命周期、参数与能力校验、错误归一化、capabilities()
   │                              │
   ▼                              ▼
[Adapter 注入]                 [SDK 内置检索]
 SqlAdapter                   精确向量 / BM25 / RRF / RAG
 VectorAdapter
   │                              │
   └──────────────┬───────────────┘
                  ▼
[ResourceReader]   read / readRange / stat / close
                  │  ByteRange [start, end)
                  ▼
[数据包]  manifest.json + data/*.parquet + vectors/*.f32
          + id-map.jsonl + id-map.offsets + indexes/ + text/
```

自下而上看这张图：

- 最底层只认字节，不认数据库；
- 往上一层只认 `ByteRange`，不认 `fetch` 或 `fs`；
- 再往上才出现“向量”“BM25”“SQL”这些语义；
- 最上层是公开 API，所有错误都已归一化成稳定错误码。

## 数据包

V1 的逻辑布局是固定的：

```text
weisql-package/
├── manifest.json
├── data/
│   └── documents.parquet
├── vectors/
│   ├── embeddings.f32
│   ├── id-map.jsonl
│   └── id-map.offsets
├── indexes/        # 可选：引擎原生索引，如 USearch
└── text/           # 可选：全文索引文件
```

四条不变量值得记住：

- 所有路径都相对 `manifest.json` 所在目录，且必须在包根内；
- 路径只允许 `/`，拒绝绝对路径、盘符、URL scheme、反斜杠、`%`、`.` 与 `..`；
- 所有资源路径在整个包内唯一；
- 数据包是不可变的：内容变了就是一次新发布，靠目录或入口指针区分版本。

`.wsql` 是可选的分发形态：把同样的目录打成一个文件，读取语义不变。它不是“另一种格式”，只是不同的搬运方式。

## Manifest 声明什么

Manifest 描述的是**数据布局**，不是引擎配置：

| 声明内容 | 例子 | 不包含 |
| --- | --- | --- |
| 格式与版本 | `format: "weisql"`、`formatVersion: "1.0.0"` | SQL 方言、函数列表 |
| 表 | 列名、列类型、可空性、主键、Parquet 路径 | 索引、分区策略 |
| 向量集合 | 维度、度量、编码、向量文件、ID Map | ANN 参数（属于 `index.params`） |
| 全文索引 | 文档数、词项数、平均长度、倒排文件 | 分词器实现 |
| 完整性 | 每个文件的 `bytes` 与 `sha256` | 发布者身份（由签名承担） |

一个关键约束：`data.bytes` 必须等于 `count × dimension × 4`。这个公式不是文档建议，而是校验器会执行的规则。它让“维度写错”这类错误在读取前就暴露。

Manifest 的字段速查见 [Manifest 参考](/docs/reference/manifest)。

## 四层校验

校验不是一个开关，而是四层，失败的位置决定了你能排查什么。

| 层级 | 检查什么 | 什么时候发生 | 典型错误码 |
| --- | --- | --- | --- |
| L1 结构 | JSON 类型、必填字段、未知字段、版本 | `open()` | `MANIFEST_INVALID`、`FORMAT_VERSION_UNSUPPORTED` |
| L2 语义 | 名称、跨字段引用、路径、计数与字节公式 | `open()` | `MANIFEST_INVALID`、`PATH_INVALID` |
| L3 内容 | 实际长度、SHA-256、JSONL 与偏移对应 | 按 `verifyChecksums` 或 Builder 发布前 | `RESOURCE_INTEGRITY_FAILED` |
| L4 引擎 | Parquet 可读性、列名与类型是否与声明一致 | SQL Adapter 打开时；CLI 使用 `--l4` | `RESOURCE_INTEGRITY_FAILED` |

两个容易误解的点：

- **L1/L2 不读取任何资源**。它们只看 Manifest 文本，所以可以在下载任何数据之前失败。
- **只有 L3 的 `all` 模式能发现同长度的内容篡改**。`manifest` 模式只比对长度。

`verifyChecksums` 的三种取值：`none`（默认，只做 L1/L2）、`manifest`（比对长度）、`all`（增量 SHA-256 并校验 ID Map 内容）。完整性校验发生在任何 Adapter 接触资源之前。

## ResourceReader

Reader 是唯一允许接触字节的地方。它只有四个方法：

```ts
interface ResourceReader {
  read(path: string, options?: ResourceReadOptions): Promise<Uint8Array>;
  readRange(path: string, range: ByteRange, options?: ResourceReadOptions): Promise<Uint8Array>;
  stat(path: string, options?: ResourceReadOptions): Promise<ResourceMetadata>;
  close(): Promise<void>;
}
```

`ByteRange` 是左闭右开区间 `[start, end)`，空范围不触发 I/O，短读必须明确失败。HTTP 实现要求 `206 Partial Content` 与匹配的 `Content-Range`；返回 `200` 的整文件响应不会被当成局部数据。

Reader 由注入方创建，**由 Runtime 负责关闭**。共享一个 Reader 给多个 Runtime 时，需要自己确认生命周期，避免提前关闭。

## Adapter

Adapter 是可替换的引擎实现，SDK 本身不绑定任何引擎。

| 类型 | 注入方式 | 不注入时 |
| --- | --- | --- |
| `SqlAdapter` | `open({ sqlAdapter })` | `db.sql()` 返回 `SQL_UNSUPPORTED` |
| `VectorAdapter` | `open({ vectorAdapter })` | 使用 SDK 内置的精确检索 |
| `ResourceReader` | `open({ resourceReader })` | 向量检索返回 `INDEX_NOT_FOUND` |

三条边界值得记住：

- **不注入就报错，不返回模拟数据**。宁可失败，也不给假结果。
- **精确与 ANN 必须可区分**。精确实现声明 `exactSearch: true`；ANN 必须声明 `false`，并通过 `diagnostics.exact` 如实反映。
- **引擎能力通过 `capabilities()` 报告**，而不是靠文档承诺。同一份代码在 Node 与浏览器里可能拿到不同的能力布尔值。

## 一次带过滤的向量查询

把上面的概念串起来，`db.vector.search()` 加 `filter` 的路径是：

1. Runtime 校验参数：集合是否存在、`topK` 是否为正整数、过滤字段是否在 Manifest 中声明；
2. 精确策略（`exact-filter-first`）先用 SQL 求出满足条件的完整 ID 集合；
3. 通过 ID Map（或 `idIndex` 反向索引）把业务 ID 映射成向量行号；
4. 按行号读取 `vectors/*.f32` 的字节区间，解码为 Float32；
5. 在允许的行上做距离扫描，用固定容量最大堆维护 Top-K；
6. 把最终候选行号映射回业务 ID，返回 `VectorHit[]`，并在 `diagnostics` 标注 `exact: true`。

如果换成 `vector-first`，第 2 步会变成“先取候选窗口，再用 SQL 过滤”。这时 `exact` 只有在窗口覆盖整个集合时才为 `true`，命中数也可能少于 `topK`。

## 常见误解

| 误解 | 实际情况 |
| --- | --- |
| “Manifest 是引擎配置” | 它是跨引擎的数据契约；引擎参数只出现在 `index.params` |
| “有 SHA-256 就说明数据可信” | 它只证明内容与声明一致，不证明发布者身份 |
| “SQL 不可用说明数据坏了” | 多半是没注入 Adapter，错误码是 `SQL_UNSUPPORTED` |
| “过滤是查询后再丢弃” | 默认策略先过滤再比较，否则不能声明 `exact` |
| “浏览器和 Node 能力相同” | 结果语义一致，能力边界不同，见 [兼容性](/docs/reference/compatibility) |
| “包大就一定会全量下载” | 多文件包按 Range 读取；`.wsql` 整包读取才会全量下载 |

## 延伸阅读

- Manifest 字段与常见校验失败：[Manifest 参考](/docs/reference/manifest)
- Adapter 与 Reader 的具体实现：[架构总览](/docs/start/architecture)
- 各能力的实现状态：[能力矩阵](/docs/reference/capabilities)
- 尚未完成的部分：[已知限制](/docs/reference/limitations)
