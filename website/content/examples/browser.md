---
title: 浏览器示例
description: 在浏览器中通过 HTTP Range 读取数据包、使用缓存、取消查询、流式容器与 DuckDB-Wasm 的可复制片段。
sidebar_position: 37
hero:
  kicker: "示例 · 浏览器"
  title: "只在需要时读取"
  lead: "浏览器端没有文件系统，所有资源都走 HTTP Range；缓存、取消与容器读取决定首屏体验。"
  chips: ["HTTP Range", "cache", "AbortSignal", "DuckDB-Wasm"]
hide_title: true
---

## 1. 打开 CDN 上的数据包

```ts
import { open, HttpResourceReader } from "@weisql/sdk";

const baseUrl = "/datasets/demo/";

const db = await open({
  manifestUrl: `${baseUrl}manifest.json`,
  resourceReader: new HttpResourceReader({ baseUrl }),
  cache: {
    maxCacheBytes: 32 * 1024 * 1024,
    maxEntryBytes: 1024 * 1024,
  },
});

console.log(db.capabilities());
```

`HttpResourceReader` 要求服务端返回 `206 Partial Content` 且 `Content-Range` 与请求一致；返回 `200` 的整文件响应会被判定为不支持 Range。

## 2. 先读能力，再渲染 UI

```ts
const capabilities = db.capabilities();

if (!capabilities.vectorExactSearch) {
  // 没有 Reader 或 Adapter 不是精确实现
}

if (!capabilities.sql) {
  // 没有注入 SqlAdapter，隐藏 SQL 输入框
}

if (!capabilities.textSearch) {
  // Manifest 没有 textIndexes，隐藏全文搜索
}
```

`capabilities()` 描述的是当前实例的接线，不是对每次调用的承诺。

## 3. 取消正在进行的检索

```ts
const controller = new AbortController();

const hits = await db.vector.search("document_embeddings", queryVector, {
  topK: 10,
  signal: controller.signal,
});

// 用户切换页面或输入新查询时
controller.abort();
```

取消是 best-effort：调用方会收到 `QUERY_CANCELLED`，但底层读取/引擎不保证立刻停止。缓存层只有所有等待者都取消时才中断底层请求。

## 4. 整包读取 `.wsql`

```ts
import { ContainerReader, open } from "@weisql/sdk";

const response = await fetch("/datasets/demo.wsql");
const bytes = new Uint8Array(await response.arrayBuffer());
const reader = new ContainerReader(bytes);

const manifest = JSON.parse(
  new TextDecoder().decode(await reader.read("manifest.json")),
);

const db = await open({
  manifest,
  resourceReader: reader,
  verifyChecksums: "all",
});
```

适合包较小、或已经整包下载的场景；大容器用流式读取。

## 5. 流式读取 `.wsql`

```ts
import {
  StreamingContainerReader,
  createHttpContainerSource,
  open,
} from "@weisql/sdk";

const reader = await StreamingContainerReader.open(
  createHttpContainerSource({ url: "/datasets/demo.wsql" }),
);

const manifest = JSON.parse(
  new TextDecoder().decode(await reader.read("manifest.json")),
);

const db = await open({
  manifest,
  resourceReader: reader,
  verifyChecksums: "all",
});
```

打开时只读固定头与 JSON 头部，之后每次查询只请求需要的文件区间。若托管忽略 Range，会退化为整包切片。

## 6. 浏览器 SQL（DuckDB-Wasm）

```ts
import { open, HttpResourceReader } from "@weisql/sdk";
import { createDuckDbWasmAdapter } from "@weisql/duckdb-wasm-adapter";

const db = await open({
  manifestUrl: "/datasets/demo/manifest.json",
  resourceReader: new HttpResourceReader({ baseUrl: "/datasets/demo/" }),
  sqlAdapter: createDuckDbWasmAdapter({
    bundles: {
      mainModule: "/vendor/duckdb/duckdb-eh.wasm",
      mainWorker: "/vendor/duckdb/duckdb-browser-eh.worker.js",
    },
    extensionRepository: `${location.origin}/extensions`,
  }),
});

const rows = await db.sql(
  "select id, title from documents where category = ?",
  ["genetics"],
  { maxRows: 50 },
);
```

parquet 扩展必须同源托管；首次加载还要拉取约 34 MB 的 WASM。

## 7. Range 不可用时降级

```ts
import { WeiSQLError } from "@weisql/sdk";

try {
  const hits = await db.vector.search("document_embeddings", queryVector, {
    topK: 10,
  });
} catch (error) {
  if (
    error instanceof WeiSQLError &&
    error.code === "CORS_OR_RANGE_UNSUPPORTED"
  ) {
    // 托管忽略了 Range：改用整包 .wsql + ContainerReader
  }
  throw error;
}
```

常见错误码：

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `CORS_OR_RANGE_UNSUPPORTED` | 服务端返回 200，忽略 Range | 启用 Range，或改用容器 |
| `INVALID_RANGE_RESPONSE` | `Content-Range` 缺失或不匹配 | 检查 CDN/代理 |
| `RESOURCE_INTEGRITY_FAILED` | 短读、摘要或尺寸不符 | 重新发布，不要绕过校验 |

## 相关页面

- [资源读取器](/docs/sdk/resource-readers)
- [单文件容器](/docs/sdk/containers)
- [DuckDB-Wasm Adapter](/docs/adapters/duckdb-wasm)
- [部署到 CDN](/docs/tooling/deploy-cdn)
