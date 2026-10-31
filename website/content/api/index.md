---
title: API 总览
description: 按包与用途索引 WeiSQL 的公开 TypeScript API，并说明导入路径、稳定性、类型约定与各 API 参考页的分工。
sidebar_position: 70
---

本页是 WeiSQL API 参考的入口：先给出五个包的导入路径和稳定性边界，再按用途列出公开导出，并说明贯穿所有 API 的类型约定。读完后你应该能判断一个功能属于哪个包、该看哪一页 API 参考。

## 包与导入路径

| 包 | 导入路径 | 运行环境 | 职责 |
| --- | --- | --- | --- |
| SDK | `@weisql/sdk` | Node.js 20+ 与浏览器 | Runtime、Manifest 校验、Reader、Builder、完整性、签名、容器、精确向量与全文检索 |
| DuckDB Adapter | `@weisql/duckdb-adapter` | Node.js 20+ | `SqlAdapter` 的 DuckDB 实现，依赖 `@duckdb/node-api` |
| DuckDB-Wasm Adapter | `@weisql/duckdb-wasm-adapter` | 浏览器 | `SqlAdapter` 的 DuckDB-Wasm 实现，依赖 Worker 与 WASM |
| USearch Adapter | `@weisql/usearch-adapter` | Node.js 22+ | `VectorAdapter` 的 HNSW 近似实现 |
| CLI | `@weisql/cli` | Node.js 20+ | `weisql` 命令，提供 `validate`、`pack`、`unpack`、`inspect`、`keygen`、`sign` 等子命令 |

`@weisql/sdk` 另有一个子路径 `@weisql/sdk/errors`，导出与根入口相同的 `WeiSQLError`、`WeiSQLErrorCode` 与 `WeiSQLErrorOptions`。日常使用从根入口导入即可；子路径主要供适配器包在只依赖错误类型时使用。

CLI 不是通过函数调用的库入口，而是 `bin` 中的 `weisql` 命令；其行为见 `/docs/tooling/build-package` 与 CLI 帮助。

## 稳定性声明

当前所有包均为 `0.1.0`，**尚未发布到 npm**。因此：

- 包名与导入路径按当前源码书写，但发布前仍可能调整；
- 本文只根据 `packages/*/src` 的公开导出描述行为，不承诺语义化版本兼容；
- 次要版本内可能收紧选项校验、增加错误码或调整返回类型；
- 源码与测试是唯一事实来源，与本文冲突时以实现为准。

如果你在仓库内本地运行，需先按根 `README.md` 的说明构建 workspace；本文不重复安装步骤。

## 公共 API 分组

下表按用途列出主要导出。同一符号可能服务多个场景（例如 `ContainerReader` 同时是 Reader 和容器 API），表中只归入一处。

| 分组 | 主要导出 | 详见 |
| --- | --- | --- |
| Runtime | `open`、`WeiSQLDatabase`、`capabilities()`、`state`、`close()`、`WeiSQLError` | `/docs/api/runtime` |
| Readers | `HttpResourceReader`、`NodeFileResourceReader`、`CachedResourceReader`、`ResourceReader`、`validateByteRange` | `/docs/api/readers` |
| 检索 | `exactVectorSearch`、`vectorDistance`、`TextIndexReader`、`bm25Score`、`reciprocalRankFusion`、`truncateToBudget` | `/docs/api/search` |
| SQL | `SqlAdapter`、`SqlAdapterCapabilities`、`SqlAdapterOpenContext`、`QueryOptions`、`SQLValue` | `/docs/api/sql` |
| Builder | `buildPackage`、`BuildPackageOptions`、`BuildReport`、`BuildStage`、`BuilderTableInput`、`BuilderVectorInput` | `/docs/api/build-sign` |
| 完整性 | `verifyManifestResources`、`declaredResources`、`validateIdMapContent`、`validateIdIndexContent`、`Sha256`、`sha256Hex` | `/docs/api/build-sign` |
| 签名 | `signManifest`、`countersignManifest`、`verifyManifestSignature`、`authorizeSigner`、`verifyAuthorizations`、`generateSigningKeyPair` | `/docs/api/build-sign` |
| 容器 | `createContainer`、`parseContainer`、`ContainerReader`、`StreamingContainerReader`、`createHttpContainerSource` | `/docs/sdk/containers` |
| Adapter 工厂 | `createDuckDbAdapter`、`createDuckDbWasmAdapter`、`createUSearchAdapter`、`createExactVectorAdapter` | `/docs/api/adapters` |

## 核心类型

| 类型 | 说明 |
| --- | --- |
| `WeiSQLManifest` | Manifest V1 的完整结构，含表、向量集合、文本索引、签名与授权 |
| `WeiSQLDatabase` | `open()` 返回的只读 Runtime，持有 `sql`、`sqlStream`、`vector`、`text`、`hybrid`、`rag` |
| `ResourceReader` | Runtime 与 Adapter 共用的字节访问接口：`read`、`readRange`、`stat`、`close` |
| `SqlAdapter` | SQL 引擎边界，由 Runtime 注入并调用 |
| `VectorAdapter` | 向量引擎边界，只接收已解析的集合、查询、Top-K 与允许行集合 |
| `VectorHit` | 向量命中：`row`、业务 `id`、`distance` 与可选 `diagnostics` |
| `BuildReport` | `buildPackage()` 的产物报告，含 Manifest、文件摘要与完整性报告 |
| `IntegrityReport` | L3 校验计数：检查数、尺寸验证数、哈希验证数与声明总字节 |
| `WeiSQLError` | 带稳定 `code` 与可选 `details` 的错误类型 |

## Runtime 对象形状

`open()` 返回的对象把查询入口按能力分组，方法本身不挂在 Runtime 顶层之外：

```ts
interface WeiSQLDatabase {
  readonly manifest: Readonly<WeiSQLManifest>;
  readonly state: RuntimeState;
  sql<T>(query: string, params?: readonly SQLValue[], options?: QueryOptions): Promise<readonly T[]>;
  sqlStream<T>(query: string, params?: readonly SQLValue[], options?: QueryOptions): Promise<AsyncIterable<T>>;
  readonly vector: { search(vectorName: string, queryVector: Float32Array | readonly number[], options?: VectorSearchOptions): Promise<readonly VectorHit[]> };
  readonly text: { search(indexName: string, query: string, options?: TextSearchOptions): Promise<readonly TextHit[]> };
  readonly hybrid: { search(options: HybridSearchOptions): Promise<readonly HybridFusionHit[]> };
  readonly rag: { search(options: RagSearchOptions): Promise<RagResult> };
  capabilities(): Readonly<WeiSQLCapabilities>;
  close(): Promise<void>;
}
```

完整语义与状态机见 `/docs/api/runtime`。

## 类型约定

- **只读返回。** 查询结果类型为 `readonly T[]`，Adapter 能力对象在运行时被 `Object.freeze`，Manifest 字段在类型层标记为只读。不要修改返回值并期望影响 Runtime。
- **距离越小越好。** `VectorHit.distance` 统一为“距离”语义：Cosine 为 `1 - 余弦相似度`，L2 为欧氏距离，IP 为点积的相反数。三种度量都按升序返回。
- **BM25 越大越好。** `TextHit.score` 是 BM25 分数，没有上界；不要与向量距离比较。
- **融合分数不可跨源比较。** `HybridFusionHit.score` 是 RRF 分数，只在同一次融合结果内可比。
- **错误按 `code` 分支。** 所有公开失败都抛 `WeiSQLError`，调用方应匹配 `code` 与 `details`，不要匹配消息文本。完整清单见 `/docs/sdk/errors`。
- **不可变对象是约定，不是深拷贝。** `open({ manifest })` 不会冻结你传入的原始对象；Runtime 通过 `Readonly` 类型与内部不修改来维持该约定。
- **整数有安全范围。** 字节数、维度、Top-K、行数预算等均要求 JavaScript 安全整数；越界或非正数通常抛 `INVALID_ARGUMENT`。
- **取消统一用 `AbortSignal`。** 已取消的操作抛 `QUERY_CANCELLED`；不同 Adapter 的中断强度由 `cancellation` 能力字段说明。

## 快速导入

SDK 的常用入口：

```ts
import {
  open,
  NodeFileResourceReader,
  HttpResourceReader,
  CachedResourceReader,
  buildPackage,
  verifyManifestResources,
  signManifest,
  verifyManifestSignature,
  createContainer,
  ContainerReader,
  WeiSQLError,
} from "@weisql/sdk";
import type {
  WeiSQLDatabase,
  WeiSQLManifest,
  ResourceReader,
  SqlAdapter,
  VectorAdapter,
  VectorHit,
  BuildReport,
  IntegrityReport,
} from "@weisql/sdk";
```

适配器按运行环境分开导入，避免把 Node.js 原生依赖带进浏览器：

```ts
import { createDuckDbAdapter } from "@weisql/duckdb-adapter";
import { createDuckDbWasmAdapter } from "@weisql/duckdb-wasm-adapter";
import { createUSearchAdapter } from "@weisql/usearch-adapter";
```

## 高频错误码

下表只用于快速定位，完整触发条件与 `details` 见 `/docs/sdk/errors`。

| 错误码 | 典型场景 |
| --- | --- |
| `INVALID_ARGUMENT` | 选项非法、缺少 Reader、参数数量不符、`maxRows` 越界 |
| `MANIFEST_INVALID` | L1/L2 结构或跨字段校验失败，`details.issues` 给出字段路径 |
| `FORMAT_VERSION_UNSUPPORTED` | Manifest 或容器版本不受支持 |
| `RESOURCE_INTEGRITY_FAILED` | 尺寸、SHA-256、ID Map、ID 索引或 L4 模式不一致 |
| `SQL_UNSUPPORTED` | 未注入 SQL Adapter、写入语句、近似 Adapter 拒绝过滤 |
| `INDEX_NOT_FOUND` | 集合、文本索引或容器内路径不存在 |
| `DATABASE_CLOSED` | Runtime 或 Adapter 关闭后继续使用 |
| `QUERY_CANCELLED` | `AbortSignal` 已触发 |
| `INTERNAL_ERROR` | 引擎或资源释放失败等未归一化错误 |

## 阅读顺序

初次接触可以按“打开 → 检索 → SQL → 构建”推进：先读 `/docs/api/runtime` 与 `/docs/api/readers`，再按需读 `/docs/api/search`、`/docs/api/sql`，最后读 `/docs/api/build-sign` 与 `/docs/api/adapters`。

## API 页面索引

| 页面 | 内容 |
| --- | --- |
| `/docs/api/runtime` | `open()`、`WeiSQLDatabase` 的方法与生命周期 |
| `/docs/api/readers` | 三种 Reader、`ResourceReader` 接口与字节范围规则 |
| `/docs/api/search` | 向量、全文、融合与 RAG 检索的签名与选项 |
| `/docs/api/sql` | `SqlAdapter` 契约、`QueryOptions` 与 `SQLValue` |
| `/docs/api/build-sign` | Builder、Manifest 校验、L3 完整性与 Ed25519 签名 |
| `/docs/api/adapters` | 三个 Adapter 工厂、能力字段与注入方式 |

## 与其他页面的关系

API 参考只回答“签名、选项、默认值、返回什么”。任务导向的流程放在对应指南中：

- 打开与注入顺序见 `/docs/sdk/open-and-lifecycle`；
- 构建与发布流程见 `/docs/tooling/build-package`；
- 完整性与签名的使用场景见 `/docs/sdk/integrity-and-signing`；
- 能力位如何组合见 `/docs/reference/capabilities`；
- Reader 的 HTTP、Node 与缓存细节见 `/docs/api/readers`。

所有站内链接均以 `/docs` 为前缀；本页不复制厂商或格式规范全文。
