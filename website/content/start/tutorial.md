---
title: 端到端教程：从 CSV 到可查询数据包
description: 从一份 CSV 开始，生成 Parquet、构建并校验数据包、在 Node.js 中检索、追加全文索引，最后打包发布到静态托管。
sidebar_position: 11
---

这是一条完整链路，不停在“能打开”：

```text
CSV → Parquet → buildPackage() → validate → open()/search → 全文索引 → .wsql → 静态托管
```

每一步都给出可执行命令与完整脚本。命令默认在仓库根目录执行；如果是仓库外的新项目，把 `@weisql/sdk` 换成发布后的 npm 包即可。

## 0. 准备

```bash
npm install
npm run build          # 构建 5 个包，生成 packages/*/dist
```

教程使用的目录：

```text
source/rows.csv              # 输入
source/documents.parquet     # 转换产物
dist/demo/                   # 数据包
build-demo.mjs               # 构建脚本
query-demo.mjs               # 查询脚本
```

## 1. 准备 CSV

创建 `source/rows.csv`：

```csv
id,title,category
doc-001,DNA 的结构,genetics
doc-002,RNA 的转录,genetics
doc-003,蛋白质折叠,protein
```

转成 Parquet：

```bash
node tools/source-to-parquet.mjs source/rows.csv --output source/documents.parquet
```

工具会打印一份可直接粘贴进 Builder 的列声明：

```json
{
  "rows": 3,
  "parquetBytes": 536,
  "columns": [
    { "name": "id", "type": "string", "nullable": false },
    { "name": "title", "type": "string", "nullable": false },
    { "name": "category", "type": "string", "nullable": false }
  ]
}
```

推断是保守的：`"001"` 不会被当成数字，混合类型会直接报错。时间戳与嵌套列不在支持范围，需要先自行整理成 Parquet。

## 2. 写构建脚本

创建 `build-demo.mjs`。Builder 接收**已有 Parquet**、向量和业务 ID，生成 Manifest、ID Map 与真实摘要：

```js
import path from "node:path";
import { buildPackage } from "./packages/sdk/dist/index.js";

const report = await buildPackage({
  outputDirectory: "dist/demo",
  overwrite: true,
  datasetId: "demo-documents",
  metadata: {
    title: "Demo documents",
    description: "Three documents with 2-dimensional cosine embeddings",
  },
  tables: [
    {
      name: "documents",
      parquetPath: "source/documents.parquet",
      columns: [
        { name: "id", type: "string", nullable: false },
        { name: "title", type: "string", nullable: false },
        { name: "category", type: "string", nullable: false },
      ],
      primaryKey: ["id"],
      // 与 Parquet 行顺序一致；提供后 Builder 会做 ID 成员交叉校验
      rowIds: ["doc-001", "doc-002", "doc-003"],
    },
  ],
  vectorCollections: [
    {
      name: "document_embeddings",
      tableName: "documents",
      idColumn: "id",
      metric: "cosine",
      dimension: 2,
      vectors: [
        [1, 0],
        [0.9, 0.1],
        [0, 1],
      ],
      ids: ["doc-001", "doc-002", "doc-003"],
    },
  ],
});

console.log(report.stage);              // PUBLISHED
console.log(report.artifacts.length);   // 生成的文件数
console.log(report.integrity);          // L3 自检结果
```

```bash
node build-demo.mjs
```

几个容易出错的点：

- `vectors.length` 必须等于 `ids.length`，且每条向量维度一致；
- Cosine 集合不允许零向量；
- `rowIds` 与 Parquet 主键列顺序必须一致，否则会报 `Business ID does not exist...`；
- 不传 `rowIds` 也能构建，但 `report.warnings` 会包含 `id-membership-unverified`，这只是“未交叉校验”，不是成功。

## 3. 校验数据包

```bash
npx weisql validate ./dist/demo --l4
```

预期输出：

```text
package:   .../dist/demo
dataset:   demo-documents
tables:    1 (documents)
vectors:   1 (document_embeddings: 3 rows, dimension 2, cosine)
mode:      all
resources: 5 checked, 5 sizes verified, 5 hashes verified, ... declared bytes
l4:        1 table(s) matched the Manifest
OK
```

`--l4` 需要 `@weisql/duckdb-adapter`，它会用 DuckDB 读取 Parquet，核对列名与类型。没有安装时报告 `[l4] SQL_UNSUPPORTED`，不会崩溃。

## 4. 在 Node.js 中查询

创建 `query-demo.mjs`：

```js
import { readFile } from "node:fs/promises";
import { open, NodeFileResourceReader } from "@weisql/sdk";

const manifest = JSON.parse(await readFile("dist/demo/manifest.json", "utf8"));

const db = await open({
  manifest,
  resourceReader: new NodeFileResourceReader({ rootDirectory: "dist/demo" }),
  verifyChecksums: "all",
});

const hits = await db.vector.search("document_embeddings", [1, 0], { topK: 2 });

for (const hit of hits) {
  console.log(hit.id, hit.distance.toFixed(4), hit.diagnostics?.exact);
}

await db.close();
```

```bash
node query-demo.mjs
# doc-001 0.0000 true
# doc-002 0.1056 true
```

`distance` 越小越相似；`diagnostics.exact` 为 `true` 表示结果来自完整扫描。`verifyChecksums: "all"` 会在任何 Adapter 接触资源前校验尺寸与 SHA-256。

## 5. 加过滤与 SQL（可选）

过滤需要注入 SQL Adapter：

```js
import { createDuckDbAdapter } from "@weisql/duckdb-adapter";

const db = await open({
  manifest,
  resourceReader: new NodeFileResourceReader({ rootDirectory: "dist/demo" }),
  sqlAdapter: createDuckDbAdapter(),
});

const rows = await db.sql(
  "select id, title from documents where category = ? order by id",
  ["genetics"],
);

const filtered = await db.vector.search("document_embeddings", [1, 0], {
  topK: 2,
  filter: { category: "genetics" },
});
```

`exact-filter-first` 会先用 SQL 求出完整允许行，再在这些行上做精确比较，所以过滤后的 Top-K 仍然严格。

## 6. 追加全文索引

```bash
node tools/build-text-index.mjs ./dist/demo --table documents --column title --name documents_text
npx weisql validate ./dist/demo
```

工具会写入倒排索引、词项偏移、文档长度与正文，并把声明回写到 Manifest。随后：

```js
const textHits = await db.text.search("documents_text", "dna", { topK: 3 });
const fused = await db.hybrid.search({
  vector: { name: "document_embeddings", query: [1, 0] },
  text: { name: "documents_text", query: "dna" },
  topK: 3,
});
const rag = await db.rag.search({
  text: { name: "documents_text", query: "dna" },
  maxCharacters: 200,
});
```

中文按字分词；BM25 分数越大越相关，与向量距离方向相反。

## 7. 打包并部署

```bash
npx weisql pack ./dist/demo --compress --output ./dist/demo.wsql
npx weisql validate ./dist/demo.wsql
```

目录模式与单文件模式二选一：

```text
dist/demo/                    → 上传整个目录，客户端按 Range 读取
dist/demo.wsql                → 上传单个对象，客户端整包或流式读取
```

浏览器侧：

```ts
import { open, HttpResourceReader } from "@weisql/sdk";

const db = await open({
  manifestUrl: "/datasets/demo/manifest.json",
  resourceReader: new HttpResourceReader({ baseUrl: "/datasets/demo/" }),
  cache: { maxCacheBytes: 32 * 1024 * 1024 },
});
```

托管必须支持 `206 Partial Content`、匹配的 `Content-Range`，并通过 CORS 暴露 `Content-Range`。完整检查项见[部署到 CDN](/docs/tooling/deploy-cdn)。

## 8. 完整检查清单

- [ ] `source-to-parquet` 输出的列声明与 Builder 的 `columns` 一致；
- [ ] `rowIds` 与 Parquet 主键列顺序一致；
- [ ] `weisql validate --l4` 通过；
- [ ] 向量维度、度量与查询向量一致；
- [ ] 需要过滤时已注入 SQL Adapter；
- [ ] 需要 RAG 时文本索引包含 `documents`；
- [ ] 发布前跑过 `verifyChecksums: "all"` 或 `validate --mode all`；
- [ ] 静态托管返回 206 且 CORS 暴露 `Content-Range`。

## 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `Vector dimension does not match` | 某条向量长度与声明的 `dimension` 不一致 | 统一维度；空集合显式传 `dimension` |
| `Business ID does not exist...` | `rowIds` 与向量 `ids` 不一致 | 核对 Parquet 主键列与顺序 |
| `RESOURCE_INTEGRITY_FAILED` | 文件被改动或 Manifest 摘要未更新 | 重新构建，不要手改摘要 |
| `SQL_UNSUPPORTED` | 没注入 Adapter，或语句不是只读 | 注入 DuckDB Adapter；只执行 SELECT/EXPLAIN |
| `INDEX_NOT_FOUND` | 索引名写错或没有 Reader | 核对 Manifest 的 `textIndexes` / `vectorCollections` 名称 |
| `CORS_OR_RANGE_UNSUPPORTED` | 托管忽略 Range 返回 200 | 启用 Range，或改用整包 `.wsql` |

延伸阅读：[构建数据包](/docs/tooling/build-package)、[向量检索](/docs/sdk/vector-search)、[全文与混合](/docs/sdk/text-and-hybrid)、[RAG](/docs/sdk/rag)、[部署到 CDN](/docs/tooling/deploy-cdn)。
