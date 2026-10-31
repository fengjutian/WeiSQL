---
title: 错误处理
description: 按 code 而不是消息文本处理 WeiSQLError，查清 16 个公共错误码的触发层、details 字段与浏览器/Node 的一致语义。
sidebar_position: 28
---

本页是错误码速查：`WeiSQLError` 的结构、每个公共 `code` 的触发条件与 `details`，以及哪些错误应该重试、哪些必须停止。读完后你能写出不依赖错误消息的稳定分支。

## 最小示例

```ts
import { WeiSQLError } from "@weisql/sdk";

try {
  await db.vector.search("document_embeddings", [1, 0], { topK: 10 });
} catch (error) {
  if (error instanceof WeiSQLError) {
    console.error(error.code, error.details);
    if (error.code === "DATABASE_CLOSED") return;     // 不应重试
    if (error.code === "RESOURCE_READ_FAILED") return; // 交给上层决定
  }
  throw error;
}
```

程序逻辑只依赖 `code` 与文档化字段；`message` 用于人类诊断，可能变化。

## WeiSQLError

```ts
class WeiSQLError extends Error {
  readonly code: WeiSQLErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;
}
```

构造支持两种形式：

```ts
new WeiSQLError("INVALID_ARGUMENT", "topK must be a positive integer", { topK: 0 });
new WeiSQLError({ code: "RESOURCE_READ_FAILED", message: "Network request failed", details: { path }, cause });
```

`name` 固定为 `"WeiSQLError"`；原始异常放在 `cause`。`details` 不得包含密钥、Cookie、Authorization、签名 URL 查询参数、完整查询参数或向量内容，实现中也遵守这一点。

## 错误码表

| `code` | 触发层 | 典型 `details` | 处理建议 |
| --- | --- | --- | --- |
| `MANIFEST_INVALID` | `open()`、`validateManifest()` | `issues: [{ path, message }]` | 修数据包，不要重试 |
| `FORMAT_VERSION_UNSUPPORTED` | Manifest 或容器解析 | `supported`（容器还含 `actual`） | 升级 SDK 或重新生成 |
| `PATH_INVALID` | Reader、完整性校验 | `path` | 视为攻击或部署错误 |
| `INVALID_ARGUMENT` | 所有公开 API | 视调用而定，如 `topK`、`maxRows`、`mode` | 修调用方输入 |
| `RESOURCE_NOT_FOUND` | `open()`、HTTP/文件/容器 | `path`、`status`、`cause` | 检查部署与大小写 |
| `RESOURCE_READ_FAILED` | Reader 传输层 | `path`、`status`、`contentLength` | 可有限重试，需支持取消 |
| `RESOURCE_INTEGRITY_FAILED` | L3、Reader、容器、L4 | `path`、`declared`、`actual`、`collection` | 停止使用，不重试掩盖 |
| `CORS_OR_RANGE_UNSUPPORTED` | HTTP Reader | `path` | 改服务端头或换加载方式 |
| `INVALID_RANGE_RESPONSE` | HTTP Reader | `path`、`range`、`contentRange` | 检查 CDN/代理 |
| `SQL_UNSUPPORTED` | `sql()`、过滤、容器外 SQL | `engine`、`strategy` | 换 Adapter 或改语句 |
| `VECTOR_DIMENSION_MISMATCH` | `vector.search()` | `expected`、`actual` | 修查询向量 |
| `VECTOR_INVALID_VALUE` | `vector.search()` | `position`、`topK` | 修查询向量或参数 |
| `INDEX_NOT_FOUND` | 向量/文本/容器查找 | 部分场景含 `index` | 检查名称与 Manifest |
| `DATABASE_CLOSED` | Runtime 与各 Reader | 可选 `state` | 重新 `open()` |
| `QUERY_CANCELLED` | 查询、读取、打开、校验 | 可选 | 由调用方决定是否重试 |
| `INTERNAL_ERROR` | 未归类故障、清理失败 | `cause`、`engine` | 记录并上报，不自动重试 |

## 分层行为

- Manifest 与格式错误发生在资源访问之前；用 `manifestUrl` 时 Manifest 本身已经请求过，但不会有任何资源读取。
- 路径错误映射为 `PATH_INVALID`，而不是 `RESOURCE_NOT_FOUND`：前者意味着包根 containment 被触发。
- 尺寸、摘要、偏移、JSONL、UTF-8、ID 索引内容不一致统一为 `RESOURCE_INTEGRITY_FAILED`，不引入同义码。
- 取消统一为 `QUERY_CANCELLED`，不会被包装成查询失败或引擎错误。
- 引擎缺失或能力不支持返回 `SQL_UNSUPPORTED`，绝不返回空结果伪装成功。
- 浏览器与 Node 对同一输入返回相同的高层 `code`；`details` 可以不同。
- 完整性失败后资源被弃用，不应通过无界重试继续读取。

## 容易踩的边界

| 场景 | 实际错误码 |
| --- | --- |
| `vector.search()` 的 `topK` 非正 | `VECTOR_INVALID_VALUE` |
| `text.search()`、`hybrid.search()`、`rag.search()` 的 `topK` 非法 | `INVALID_ARGUMENT` |
| 带 `filter` 但没有 `sqlAdapter` | `SQL_UNSUPPORTED` |
| 注入了 Adapter 但没有 Reader | `INVALID_ARGUMENT`（打开时） |
| 没有 Reader 时向量或全文搜索 | `INDEX_NOT_FOUND` |
| `verifyChecksums` 非 `none` 但没有 Reader | `INVALID_ARGUMENT` |
| 容器路径不存在 | `INDEX_NOT_FOUND`（不是 `RESOURCE_NOT_FOUND`） |
| 容器魔数或头部损坏 | `RESOURCE_INTEGRITY_FAILED` |
| 容器版本未知 | `FORMAT_VERSION_UNSUPPORTED` |
| HTTP 服务端忽略 Range 返回 200 | `CORS_OR_RANGE_UNSUPPORTED` |
| 签名 PEM 非法、重复签名或超过 8 条 | `INVALID_ARGUMENT` |
| 多签要求大于 1 但没给 `trustedKeyIds` | `INVALID_ARGUMENT` |
| `close()` 期间资源释放失败 | `INTERNAL_ERROR`，但 `state` 仍为 `CLOSED` |

## 按操作定位

| 操作 | 最可能出现的码 |
| --- | --- |
| `open({ manifestUrl })` | `RESOURCE_NOT_FOUND`、`MANIFEST_INVALID`、`FORMAT_VERSION_UNSUPPORTED` |
| `open({ manifest })` | `MANIFEST_INVALID`、`INVALID_ARGUMENT` |
| 打开时 L3 校验 | `RESOURCE_INTEGRITY_FAILED`、`PATH_INVALID`、`QUERY_CANCELLED` |
| `reader.readRange()` | `CORS_OR_RANGE_UNSUPPORTED`、`INVALID_RANGE_RESPONSE`、`RESOURCE_READ_FAILED` |
| `vector.search()` | `INDEX_NOT_FOUND`、`VECTOR_DIMENSION_MISMATCH`、`VECTOR_INVALID_VALUE`、`SQL_UNSUPPORTED` |
| `text.search()` | `INDEX_NOT_FOUND`、`RESOURCE_INTEGRITY_FAILED`、`INVALID_ARGUMENT` |
| `hybrid.search()` | 上述两路错误原样上抛，另有 `INVALID_ARGUMENT` |
| `rag.search()` | `INVALID_ARGUMENT`（缺 `text` 或 `documents`）、`INDEX_NOT_FOUND` |
| `sql()` | `SQL_UNSUPPORTED`、`INVALID_ARGUMENT`、`QUERY_CANCELLED` |
| `ContainerReader` | `RESOURCE_INTEGRITY_FAILED`、`FORMAT_VERSION_UNSUPPORTED`、`INDEX_NOT_FOUND` |
| 签名与授权 | `INVALID_ARGUMENT`、`MANIFEST_INVALID` |

## 日志与上报

记录 `code`、操作名、资源逻辑路径与 `details` 中的非敏感字段即可；不要记录完整查询参数、向量内容、签名私钥或带签名的 URL。未知 `code` 应按“不可恢复”处理并上报，不要假设它等同于 `INVALID_ARGUMENT`。

## 重试策略

只有传输类错误适合有限重试：

- `RESOURCE_READ_FAILED`：指数退避、限次、可取消。
- 部分 `RESOURCE_NOT_FOUND`：若是部署尚未生效，可延迟重试；404 本身不要无限重试。
- `QUERY_CANCELLED`：由调用方的取消意图决定，通常不自动重试。
- `DATABASE_CLOSED`：只能重新 `open()`，不能重试原对象。
- `RESOURCE_INTEGRITY_FAILED`、`MANIFEST_INVALID`、`PATH_INVALID`：不要重试，重试只会重复失败。

```ts
async function withRetry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const retryable = error instanceof WeiSQLError && error.code === "RESOURCE_READ_FAILED";
      if (!retryable || attempt >= attempts) throw error;
      await new Promise(resolve => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
    }
  }
}
```

重试必须限量、可取消，并采用退避；对完整性或格式错误重试不会改变结果。

## 新增错误码的兼容规则

错误码是公共契约：现有含义不得静默改变；新增码需要文档、测试与“未知码回退”策略。适配器专用的异常必须在边界转换为 `WeiSQLError`，调用方不应看到引擎原生错误类型。

## 行为边界

- `details` 的内容按安全规范裁剪，因此可能缺少你期望的调试字段。
- 浏览器端 SQL 的取消是 best-effort，`details.engineMayStillRun` 说明引擎可能仍在运行。
- 错误消息与 `details` 的具体形状可能随版本补充；只有 `code` 是稳定分支依据。
- 真实 CDN 返回的错误头组合未全部验证，HTTP 错误的细分可能随实现调整。

## 延伸阅读

- [SDK API 契约](https://github.com/fengjutian/WeiSQL/blob/main/docs/SDK_API_CONTRACT_V1.md)
- [V1 公共类型与错误契约](https://github.com/fengjutian/WeiSQL/blob/main/docs/PUBLIC_TYPES_AND_ERRORS_V1.md)
