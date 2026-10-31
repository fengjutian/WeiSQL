---
title: 构建与发布示例
description: 从 CSV 生成 Parquet、构建数据包、追加全文/ANN 索引、校验、打包与签名的可复制命令与脚本。
sidebar_position: 38
hero:
  kicker: "示例 · 构建"
  title: "从源数据到可发布数据包"
  lead: "Builder 接收已有 Parquet；CSV/JSON 转换、全文索引与 ANN 索引是独立工具，校验与签名是发布闸门。"
  chips: ["CSV", "buildPackage", "text index", "validate"]
hide_title: true
---

## 1. CSV / JSON → Parquet

```bash
node tools/source-to-parquet.mjs source/rows.csv \
  --output source/documents.parquet

node tools/source-to-parquet.mjs source/rows.jsonl \
  --output source/documents.parquet
```

工具会打印列声明，可直接粘贴到 Builder 的 `columns`：

```json
{
  "rows": 3,
  "parquetBytes": 536,
  "columns": [
    { "name": "id", "type": "string", "nullable": false },
    { "name": "title", "type": "string", "nullable": false }
  ]
}
```

推断是保守的：`"001"` 保持字符串，混合类型会直接报错；时间戳与嵌套列需要先自行整理。

## 2. 最小 Builder

```ts
import { buildPackage } from "@weisql/sdk";

const report = await buildPackage({
  outputDirectory: "dist/demo",
  overwrite: true,
  datasetId: "demo-documents",
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
      rowIds: ["doc-001", "doc-002", "doc-003"],
    },
  ],
  vectorCollections: [
    {
      name: "document_embeddings",
      tableName: "documents",
      idColumn: "id",
      metric: "cosine",
      vectors: [
        [1, 0],
        [0.9, 0.1],
        [0, 1],
      ],
      ids: ["doc-001", "doc-002", "doc-003"],
    },
  ],
});

console.log(report.stage);        // PUBLISHED
console.log(report.integrity);    // L3 自检结果
```

不传 `rowIds` 也能构建，但会在 `report.warnings` 中报告 `id-membership-unverified:<collection>`。

## 3. 构建时签名

```ts
// tables / vectorCollections 沿用上面的定义
const report = await buildPackage({
  outputDirectory: "dist/demo",
  datasetId: "demo-documents",
  tables,
  vectorCollections,
  signing: {
    privateKeyPem,
    publicKeyPem,
  },
});

console.log(report.signature?.keyId); // sha256:...
```

WebCrypto 不能从私钥推导公钥，所以两个 PEM 必须同时提供。包从落盘起就是签名状态，不依赖发布脚本补签。

## 4. 追加全文索引

```bash
node tools/build-text-index.mjs ./dist/demo \
  --table documents \
  --column title \
  --name documents_text

npx weisql validate ./dist/demo
```

工具会写入倒排、词项偏移、文档长度与正文，并把声明回写到 Manifest。之后可用 `db.text.search()`、`db.hybrid.search()` 与 `db.rag.search()`。

## 5. 追加 ANN 索引

```bash
node tools/build-ann-index.mjs ./dist/demo \
  --connectivity 16 \
  --expansion-add 128 \
  --expansion-search 512

npx weisql validate ./dist/demo
```

索引写入 `indexes/<collection>.usearch`，参数回写到 Manifest 的 `index.params`。没有声明索引时，USearch Adapter 会在首次检索时现场构建。

## 6. 发布前校验

```bash
npx weisql validate ./dist/demo --l4
npx weisql validate ./dist/demo --json --mode all
npx weisql validate ./dist/demo.wsql
```

- `--mode all` 校验尺寸与 SHA-256；
- `--l4` 额外用 DuckDB 核对 Parquet 列名与类型；
- 退出码 `0` 有效、`1` 无效、`2` 用法错误。

## 7. 打包与检查

```bash
npx weisql pack ./dist/demo --compress --output ./dist/demo.wsql
npx weisql inspect ./dist/demo
npx weisql unpack ./dist/demo.wsql --output ./dist/extracted
```

`inspect` 不打开 Runtime，会列出表、向量、全文索引、签名状态以及**未被 Manifest 声明的文件**；`unpack` 先校验全部摘要再写盘。

## 8. 手动做 L3 校验

```ts
import { readFile } from "node:fs/promises";
import { verifyManifestResources, NodeFileResourceReader } from "@weisql/sdk";

const manifest = JSON.parse(
  await readFile("dist/demo/manifest.json", "utf8"),
);
const reader = new NodeFileResourceReader({ rootDirectory: "dist/demo" });

const report = await verifyManifestResources({
  manifest,
  reader,
  options: { mode: "all" },
});

console.log(report.checkedResources);
console.log(report.sizeVerified);
console.log(report.hashesVerified);
console.log(report.totalDeclaredBytes);
```

三个计数刻意分开：“检查了声明”“验证了实际长度”“完整读取并验证了哈希”不是同一件事。

## 9. 签名与验签（CLI）

```bash
mkdir -p ./keys
npx weisql keygen --output ./keys/release
npx weisql sign ./dist/demo --key ./keys/release.key.pem
npx weisql verify-signature ./dist/demo --trusted <keyId>
```

需要根密钥授权发布密钥时：

```bash
npx weisql authorize ./dist/demo \
  --root ./keys/root.key.pem \
  --signer ./keys/release.pub.pem \
  --key ./keys/release.key.pem \
  --days 365

npx weisql validate ./dist/demo --signature --trusted-root <rootKeyId>
```

## 相关页面

- [构建数据包](/docs/tooling/build-package)
- [CLI](/docs/tooling/cli)
- [完整性与签名](/docs/sdk/integrity-and-signing)
- [单文件容器](/docs/sdk/containers)
