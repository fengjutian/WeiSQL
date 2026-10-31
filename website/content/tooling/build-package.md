---
title: 构建数据包
description: 用 buildPackage 从已有 Parquet、向量和业务 ID 生成可校验的数据包，理解阶段、覆盖、签名与警告。
sidebar_position: 41
hero:
  kicker: "工具链 · 构建"
  title: "从 Parquet 到可发布数据包"
  lead: "Builder 生成向量、ID Map、摘要，并在发布前重新读取暂存区做自检。"
  chips: ["buildPackage()", "L3", "atomic"]
hide_title: true
examples: [build]
---


`buildPackage()` 是 V1 的数据包构建入口：接收已经存在的 Parquet 文件、原始向量和业务 ID，生成 Float32 向量文件、ID Map、真实字节数与 SHA-256 的 Manifest，并在发布前把整个暂存区重新读一遍做 L1/L2/L3 自检。读完本页你应当能构造一次成功构建，并解释失败时包为什么没有落盘。

Builder 不负责从 CSV/JSON 推断类型，也不做列裁剪。CSV/JSON 转换是独立工具，见下文。

## 最小示例

```ts
import { buildPackage } from "@weisql/sdk";

const report = await buildPackage({
  outputDirectory: "fixture",
  datasetId: "demo-documents",
  tables: [{
    name: "documents",
    parquetPath: "source/documents.parquet",
    columns: [
      { name: "id", type: "string", nullable: false },
      { name: "title", type: "string", nullable: false },
      { name: "category", type: "string", nullable: false },
    ],
    primaryKey: ["id"],
    rowIds: ["doc-001", "doc-002", "doc-003"],
  }],
  vectorCollections: [{
    name: "document_embeddings",
    tableName: "documents",
    idColumn: "id",
    metric: "cosine",
    vectors: [[1, 0], [0.9, 0.1], [0, 1]],
    ids: ["doc-001", "doc-002", "doc-003"],
  }],
  overwrite: false,
});

console.log(report.stage);       // "PUBLISHED"
console.log(report.warnings);    // 未提供 rowIds 时会包含 id-membership-unverified
console.log(report.artifacts);   // 每个文件的 path / bytes / sha256
```

构建成功后，目录里是可被 `open()` 直接读取的完整包；构建失败时不会留下半成品。

## 选项

| 选项 | 类型 | 必填 | 作用 |
| --- | --- | --- | --- |
| `outputDirectory` | `string` | 是 | 目标目录；不能是文件系统根、当前工作目录或其祖先 |
| `datasetId` | `string` | 是 | 非空数据集标识，写入 Manifest |
| `tables` | `BuilderTableInput[]` | 是 | 至少一张表 |
| `vectorCollections` | `BuilderVectorInput[]` | 是 | 至少一个向量集合 |
| `metadata` | `object` | 否 | `title`、`description`、`createdAt`、`builderVersion` |
| `signing` | `{ privateKeyPem, publicKeyPem }` | 否 | 写入前完成 Ed25519 签名 |
| `overwrite` | `boolean` | 否 | 允许替换已有目录，默认 `false` |
| `jobId` | `string` | 否 | 诊断用作业标识，默认随机生成 |
| `signal` | `AbortSignal` | 否 | 取消构建 |

表输入：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | `string` | 表名，必须唯一 |
| `parquetPath` | `string` | 已存在的 Parquet 文件路径 |
| `columns` | `ColumnDescriptor[]` | 至少一列；类型声明写入 Manifest |
| `primaryKey` | `string[]` | 主键列 |
| `rowIds` | `(string \| number)[]` | Parquet 行顺序的主键值，用于向量 ID 成员校验 |

向量集合输入：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `name` | `string` | 集合名，必须唯一 |
| `tableName` | `string` | 必须是已声明的表 |
| `idColumn` | `string` | 必须是该表已声明的列 |
| `metric` | `"cosine" \| "l2" \| "ip"` | 距离度量 |
| `vectors` | `(Float32Array \| number[])[]` | 每行一个向量，行主序 |
| `ids` | `(string \| number)[]` | 与 `vectors` 等长、同序 |
| `dimension` | `number` | 空集合必填；否则从首条向量推断 |
| `uniqueIds` | `boolean` | 默认 `true`；为 `false` 时允许重复 ID |

## 行为与边界

### 构建阶段

```text
CREATED → VALIDATING → BUILDING → VERIFYING → PUBLISHING → PUBLISHED
```

任一阶段失败进入 `FAILED` 并清理暂存区。异常是 `WeiSQLError`，`details` 带 `jobId`、`stage`、`stagingCleaned` 与 `outputDirectory`，便于定位失败发生在哪一步。

### 覆盖与发布

- 目标已存在且 `overwrite` 不是 `true`：`INVALID_ARGUMENT`；
- 目标存在但不是目录：`INVALID_ARGUMENT`；
- 目标是根目录、当前工作目录或其祖先：拒绝，避免把工程目录整体替换；
- `overwrite: true` 时先把旧目录改名为备份，新包原子改名成功后才删除备份；发布失败会尝试回滚旧目录。

### 输入校验

Builder 在写任何资源之前检查：表名/集合名不重复、每张表至少一列、每个集合引用已声明的表与列、`ids` 与 `vectors` 等长、向量维度一致且不超过 65,536、向量不含 `NaN`/`Infinity`、Cosine 集合不含零向量。业务 ID 必须是非空字符串或安全整数；默认不允许重复。

### rowIds 与主键交叉校验

提供 `rowIds` 时，每个向量 ID 都会检查是否存在于目标表主键中，不存在则 `INVALID_ARGUMENT`。未提供时 Builder 不会假装完成交叉校验，而是在 `report.warnings` 中报告 `id-membership-unverified`。要去掉这个警告，需要在构建前拿到 Parquet 的主键列值。

### 生成的文件

- Parquet 原样复制，不重新编码；
- 向量写成 Float32 little-endian、行主序；
- ID Map 写成 UTF-8 JSONL 加 UInt64 偏移；
- 同时生成 `id → row` 反向索引，供过滤查询使用；
- Manifest 记录真实字节数与 SHA-256；提供 `metadata` 时，`builderVersion` 默认为 `weisql-builder/0.1.0`。

`report.artifacts` 给出每个文件的 `path`、`bytes` 与 `sha256`；`report.integrity` 是自检的 L3 结果。

### 构建时签名

传入 `signing: { privateKeyPem, publicKeyPem }` 后，Manifest 在写入前完成签名，`report.signature.keyId` 给出指纹。这样包从落盘那一刻起就是签名的，不依赖发布脚本事后补签。只提供其中一个密钥会失败。

### 明确不做

- 不接收 CSV/JSON，不做类型推断、列裁剪或分片；
- 不生成全文索引或 ANN 索引；它们由 `tools/build-text-index.mjs` 与 `tools/build-ann-index.mjs` 追加；
- 不压缩、不加密输出目录；需要单文件时用 `weisql pack`。

## 从 CSV / JSON 生成 Parquet

```bash
node tools/source-to-parquet.mjs rows.csv   --output source/documents.parquet
node tools/source-to-parquet.mjs rows.jsonl --output source/documents.parquet
node tools/source-to-parquet.mjs rows.json  --output source/documents.parquet
```

`--format csv|json` 可在扩展名不可靠时显式指定格式。命令会打印可直接粘进 `columns` 的声明：

```json
{
  "rows": 3,
  "parquetBytes": 536,
  "columns": [
    { "name": "id", "type": "string", "nullable": false },
    { "name": "rating", "type": "float64", "nullable": false }
  ]
}
```

推断是保守的：JSON 保留原生类型；CSV 只在无损时转数字（`"001"` 保持字符串，`"1"` 变整数），布尔只认 `true`/`false`；同一列混合类型直接报错。时间戳、嵌套对象/数组、增量追加与多文件分片都不支持。

## 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `Output directory already exists` | 未传 `overwrite` | 换目标目录，或明确传 `overwrite: true` |
| `Parquet file could not be read` | 路径错误或不是普通文件 | 先跑 `source-to-parquet.mjs`，核对路径 |
| `Vector dimension does not match` | 某条向量长度与集合维度不一致 | 统一维度；空集合显式传 `dimension` |
| `Cosine collections must not contain zero vectors` | Cosine 集合里有全零向量 | 过滤零向量或改用其他度量 |
| `Business ID does not exist in the target table primary key` | `rowIds` 与向量 ID 不一致 | 核对 Parquet 主键列顺序与取值 |
| `id-membership-unverified` 警告 | 没有提供 `rowIds` | 提供主键值，或接受未交叉校验的事实 |

## 延伸阅读

- [Manifest 参考](/docs/reference/manifest)：`buildPackage` 写出的字段。
- [数据包概念](/docs/start/concepts)：表、向量、ID Map 与索引的关系。
- [源数据转换](https://github.com/fengjutian/WeiSQL/blob/main/docs/SOURCE_CONVERSION.md)。
- [Builder 规范](https://github.com/fengjutian/WeiSQL/blob/main/docs/MANIFEST_VALIDATOR_BUILDER_SPEC.md)。
- [CLI](/docs/tooling/cli)：构建完成后的 `validate` 与 `pack`。
