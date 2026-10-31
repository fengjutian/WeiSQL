---
title: Node.js 示例
description: 在 Node.js 中打开数据包、向量检索、过滤、全文、混合、RAG、SQL 与容器读取的可复制片段。
sidebar_position: 36
hero:
  kicker: "示例 · Node.js"
  title: "在 Node.js 里查询"
  lead: "从本地目录打开数据包，跑向量、全文、融合、RAG 与 SQL；每个片段都可以单独复制。"
  chips: ["readFile", "vector.search", "sqlStream", "ContainerReader"]
hide_title: true
---

## 1. 打开本地数据包

本地目录不是 HTTP 服务，所以先用 `readFile` 得到 Manifest 对象，再交给 `open()`：

```ts
import { readFile } from "node:fs/promises";
import { open, NodeFileResourceReader } from "@weisql/sdk";

const root = "dist/demo";
const manifest = JSON.parse(await readFile(`${root}/manifest.json`, "utf8"));

const db = await open({
  manifest,
  resourceReader: new NodeFileResourceReader({ rootDirectory: root }),
  verifyChecksums: "all",
});

try {
  console.log(db.state);        // READY
  console.log(db.capabilities());
} finally {
  await db.close();
}
```

## 2. 精确向量检索

```ts
const hits = await db.vector.search(
  "document_embeddings",
  [0.2, 0.9],
  { topK: 5 },
);

for (const hit of hits) {
  console.log(hit.id, hit.distance, hit.diagnostics?.exact);
}
```

`distance` 越小越相似。`diagnostics.exact` 为 `true` 表示结果来自完整扫描。

## 3. 带过滤的向量检索

过滤需要注入 SQL Adapter：

```ts
// 需要 sqlAdapter；manifest / root 沿用第 1 节
import { createDuckDbAdapter } from "@weisql/duckdb-adapter";

const db = await open({
  manifest,
  resourceReader: new NodeFileResourceReader({ rootDirectory: root }),
  sqlAdapter: createDuckDbAdapter(),
});

const hits = await db.vector.search("document_embeddings", [0.2, 0.9], {
  topK: 5,
  filter: { category: "genetics" },
  strategy: "exact-filter-first",
});
```

也可以显式使用 `{ in: [...] }`、范围 `{ gte, lt }`、`{ ne }` 或 `null`；条件之间是 AND。

## 4. 全文与混合检索

```ts
const textHits = await db.text.search("documents_text", "dna", { topK: 5 });

const fused = await db.hybrid.search({
  topK: 5,
  k: 60,
  vector: {
    name: "document_embeddings",
    query: [0.2, 0.9],
    topK: 20,
  },
  text: {
    name: "documents_text",
    query: "dna",
    topK: 20,
  },
});

console.log(textHits[0]?.score);   // BM25，越大越相关
console.log(fused[0]?.ranks);      // { vector: 1, text: 2 }
```

`hybrid.search()` 只使用名次融合，`score` 不能和 BM25 分数或向量距离直接比较。

## 5. RAG 证据组装

```ts
const result = await db.rag.search({
  text: { name: "documents_text", query: "dna" },
  vector: { name: "document_embeddings", query: [0.2, 0.9] },
  topK: 5,
  maxCharacters: 2000,
});

for (const evidence of result.evidences) {
  console.log(`[${evidence.rank}] ${evidence.id}`);
  console.log(evidence.text);
  console.log(evidence.truncated, evidence.boundary);
}
```

需要文本索引声明了 `documents`，否则返回 `INVALID_ARGUMENT`。它不调用模型，也不拼 prompt。

## 6. SQL 与流式 SQL

```ts
// db 需要注入 createDuckDbAdapter()
const rows = await db.sql(
  "select id, title from documents where category = ? order by id",
  ["genetics"],
  { maxRows: 100 },
);

const stream = await db.sqlStream(
  "select id, title from documents order by id",
  [],
  { maxRows: 1000 },
);

for await (const row of stream) {
  console.log(row.id);
  if (row.id === "doc-050") break;   // 提前结束会关闭底层结果
}
```

`maxRows` 超限会抛 `INVALID_ARGUMENT`，不会静默截断。

## 7. 读取 `.wsql` 容器

```ts
import { readFile } from "node:fs/promises";
import { ContainerReader, open } from "@weisql/sdk";

const bytes = new Uint8Array(await readFile("dist/demo.wsql"));
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

`ContainerReader` 需要完整文件在内存；大容器改用 `StreamingContainerReader`。

## 8. 取消、错误与清理

```ts
import { WeiSQLError } from "@weisql/sdk";

const controller = new AbortController();
setTimeout(() => controller.abort(), 500);

try {
  await db.vector.search("document_embeddings", [1, 0], {
    topK: 10,
    signal: controller.signal,
  });
} catch (error) {
  if (error instanceof WeiSQLError && error.code === "QUERY_CANCELLED") {
    // 调用方主动取消
  } else {
    throw error;
  }
}
```

程序分支只依赖 `error.code`，不要匹配错误消息；关闭用 `finally { await db.close(); }`。

## 相关页面

- [向量检索](/docs/sdk/vector-search)
- [全文与混合](/docs/sdk/text-and-hybrid)
- [RAG](/docs/sdk/rag)
- [SQL](/docs/sdk/sql)
- [错误处理](/docs/sdk/errors)
