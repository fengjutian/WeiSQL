---
title: Manifest 字段速查
description: 汇总 V1 Manifest 的顶层字段、表与向量集合约束、最小示例，以及最常见的校验失败与排查方向。
sidebar_position: 50
---

Manifest 是数据包的公开契约。本页给结论和速查表，不复制完整 Schema；机器可读定义见仓库里的 `docs/MANIFEST_SCHEMA_V1.json`。

先记住三条硬约束：

- `format` 固定为 `weisql`，`formatVersion` 固定为 `1.0.0`；
- 所有资源路径相对 `manifest.json`，必须包根内且全局唯一；
- 每个文件描述必须带真实的 `bytes` 与 `sha256`，占位值过不了 L3。

## 顶层字段

| 字段 | 必填 | 取值/约束 | 说明 |
| --- | --- | --- | --- |
| `format` | 是 | 常量 `weisql` | 协议标识 |
| `formatVersion` | 是 | 常量 `1.0.0` | 主版本不受支持时返回 `FORMAT_VERSION_UNSUPPORTED` |
| `datasetId` | 是 | 1–128 字符，字母数字开头，仅含字母、数字、`.`、`_`、`-` | 稳定数据集身份，不随发布变化 |
| `tables` | 是 | 数组，最多 10,000 项 | 表定义 |
| `vectorCollections` | 是 | 数组，最多 10,000 项 | 向量集合定义，允许为空数组 |
| `textIndexes` | 否 | 数组，最多 1,000 项 | 全文索引定义 |
| `metadata` | 否 | 仅 `title`、`description`、`createdAt`、`builderVersion` | 人类可读信息，不参与检索 |
| `signature` | 否 | `signatures` 与它二选一 | Ed25519 单签名 |
| `signatures` | 否 | 1–8 项 | 多签名，语义是全部有效 |
| `authorizations` | 否 | 1–8 项 | 根密钥授权链 |

未知顶层字段会被拒绝。Manifest 里没有“发布版本”字段，版本目录与入口指针由部署层管理。

## 表定义

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `name` | 是 | 标识符，表内唯一，最长 128 字符 |
| `file.path` | 是 | 规范相对路径 |
| `file.bytes` | 是 | 非负安全整数 |
| `file.sha256` | 是 | 64 位十六进制 |
| `format` | 是 | 常量 `parquet` |
| `columns[].name` | 是 | 标识符，列内唯一 |
| `columns[].type` | 是 | `string`、`int32`、`int64`、`float32`、`float64`、`boolean`、`timestamp`、`date`、`json` |
| `columns[].nullable` | 是 | 布尔 |
| `primaryKey` | 是 | 至少一列，引用已声明的非空列，互不重复 |

列数上限 10,000。`json` 列是不透明文本：Manifest 不声明也不校验其规范化形式。

## 向量集合

| 字段 | 必填 | 约束 |
| --- | --- | --- |
| `name` | 是 | 标识符，包内唯一 |
| `tableName` | 是 | 引用已存在的表 |
| `idColumn` | 是 | 必须是该表的主键列 |
| `count` | 是 | 非负安全整数，允许 0 |
| `dimension` | 是 | 1–65,536 |
| `metric` | 是 | `cosine`、`l2`、`ip` |
| `encoding` | 是 | 常量 `f32-le-row-major` |
| `data` | 是 | 向量文件描述 |
| `idMap` | 是 | 见下 |
| `index` | 否 | `engine`、`version`、`file`、`params?` |
| `idIndex` | 否 | ID 反向索引，过滤查询用 |

字节公式（L2 会算，且用 BigInt 防溢出）：

- `data.bytes = count × dimension × 4`；
- `idMap.offsets.bytes = idMap.count × 8`；
- `idMap.count = count`；
- `idIndex.count = count`，`idType` 必须与 `idColumn` 类型一致。

`index.params` 是扁平数字表（最多 32 项，键为标识符）。加载方无法重建参数时必须拒绝加载，不能猜默认值。USearch 目前使用 `connectivity`、`expansion_add`、`expansion_search`。

距离语义统一为“越小越相似”：Cosine 是 `1 - similarity`，L2 是欧氏距离，IP 是负内积。

## ID Map 与全文索引

`idMap` 的四个字段：`data`（`jsonl`）、`offsets`（`uint64-le`）、`count`、`uniqueIds`。JSONL 每行是 `{ "row": number, "id": string | integer }`，行号从 0 连续递增；偏移第一项为 0、严格递增、不超过 JSONL 长度。

全文索引（`textIndexes[]`）的必填项：

| 字段 | 约束 |
| --- | --- |
| `name` / `tableName` / `column` / `idColumn` | 引用存在；`column` 必须是 `string` 或 `json` 列 |
| `documentCount` / `termCount` | ≥ 1，是声明值，运行时不重算 |
| `averageDocumentLength` | > 0 |
| `data` / `termOffsets` / `docLengths` | 倒排、词项偏移（u64-le）、文档长度（u32-le） |
| `idMap` | `count` 必须等于 `documentCount` |
| `documents` | 可选，行 → 原文，供 RAG 使用 |
| `k1` / `b` | 可选，默认 1.2 / 0.75，`b` 范围 [0, 1] |

`termOffsets.bytes = termCount × 8`，`docLengths.bytes = documentCount × 4`。三个文件都参与 L3 校验。

## 最小示例

下面取自仓库的 `examples/fixture`，是一份能通过 L1/L2/L3 的真实 Manifest（3 行、2 维）：

```json
{
  "format": "weisql",
  "formatVersion": "1.0.0",
  "datasetId": "demo-documents",
  "tables": [
    {
      "name": "documents",
      "file": {
        "path": "data/documents.parquet",
        "bytes": 832,
        "sha256": "c1c93b539dc7a7db3c542ae7841b53ed3114910b90f88f57e30b4e23e12c6ab0"
      },
      "format": "parquet",
      "columns": [
        { "name": "id", "type": "string", "nullable": false },
        { "name": "title", "type": "string", "nullable": false },
        { "name": "category", "type": "string", "nullable": false }
      ],
      "primaryKey": ["id"]
    }
  ],
  "vectorCollections": [
    {
      "name": "document_embeddings",
      "tableName": "documents",
      "idColumn": "id",
      "count": 3,
      "dimension": 2,
      "metric": "cosine",
      "encoding": "f32-le-row-major",
      "data": {
        "path": "vectors/document_embeddings.f32",
        "bytes": 24,
        "sha256": "fc61b7819b5d81c32de1c4b26e27931a9d8e2ce05b41a4c7be9856db5706770f"
      },
      "idMap": {
        "data": {
          "path": "vectors/document_embeddings.id-map.jsonl",
          "bytes": 75,
          "sha256": "d991304ff54a612ffaa90449d716437aeae5a1bdeff284e020eeef0967e81554",
          "format": "jsonl"
        },
        "offsets": {
          "path": "vectors/document_embeddings.id-map.offsets",
          "bytes": 24,
          "sha256": "1b4e15f2817371022e098726f0d1f925c14d0749993ee97432cdbdddf5e712ef",
          "format": "uint64-le"
        },
        "count": 3,
        "uniqueIds": true
      }
    }
  ],
  "metadata": {
    "title": "WeiSQL AI E2E fixture",
    "createdAt": "2026-10-30T00:00:00Z"
  }
}
```

照抄时最容易漏掉的是 `idMap` 里两个文件的 `format` 字段，以及 `idMap.count` 必须与向量 `count` 相等。

## 签名相关字段

| 字段 | 取值 |
| --- | --- |
| `signature.algorithm` | 常量 `ed25519` |
| `signature.keyId` | `sha256:<64 位小写十六进制>`，公钥 SPKI 指纹 |
| `signature.publicKey` | base64 SPKI |
| `signature.value` | base64 签名，64 字节 |

签名覆盖“去掉 `signature` 字段后的规范化 Manifest”，前缀为 `weisql-manifest-v1\n`，规范化规则是键排序、无空白的 JSON。签名不属于 L1–L3，它证明发布后未被篡改；发布者身份需要调用方固定 `keyId`。

## 常见校验失败

| 现象 | 层级 | 错误码 | 原因与修法 |
| --- | --- | --- | --- |
| 版本被拒 | L1 | `FORMAT_VERSION_UNSUPPORTED` | 写了 `2.0.0` 之类的主版本；V1 只接受 `1.0.0` |
| 多了一个字段 | L1 | `MANIFEST_INVALID` | Schema 设了 `additionalProperties: false`；删除未定义字段 |
| 路径被判非法 | L1/L2 | `MANIFEST_INVALID`、`PATH_INVALID` | 用了 `..`、绝对路径、反斜杠、`%` 或空段 |
| 两个资源同路径 | L2 | `MANIFEST_INVALID` | 资源路径必须全包唯一；检查 `data/` 与 `vectors/` 是否撞名 |
| 向量文件大小对不上 | L2 | `MANIFEST_INVALID` | 忘了 `count × dimension × 4`；检查维度或行数 |
| ID Map 偏移数不对 | L2 | `MANIFEST_INVALID` | `offsets.bytes` 必须是 `idMap.count × 8` |
| 引用了不存在的表/列 | L2 | `MANIFEST_INVALID` | `tableName`、`idColumn`、过滤字段都必须在 Manifest 中声明 |
| 摘要或长度不符 | L3 | `RESOURCE_INTEGRITY_FAILED` | 文件被改动或打包漏文件；用 `weisql validate --mode all` 定位 |
| 列类型与 Parquet 不一致 | L4 | `RESOURCE_INTEGRITY_FAILED` | Manifest 声明与 Parquet 实际 schema 不同；用 `--l4` 复现 |
| 加载索引被拒 | L2/Runtime | `MANIFEST_INVALID` | `index.params` 缺失或不完整；不要假设默认值 |

排查顺序建议：先 `weisql validate`（L1/L2/L3），再加 `--l4`。失败时用 `--json` 拿到 `issues[].stage`、`code` 与 `details.path`。

## 延伸阅读

- 完整规范与外链原文：[Manifest V1 规范](https://github.com/fengjutian/WeiSQL/blob/main/docs/MANIFEST_SPEC_V1.md)
- JSON Schema：[MANIFEST_SCHEMA_V1.json](https://github.com/fengjutian/WeiSQL/blob/main/docs/MANIFEST_SCHEMA_V1.json)
- 校验命令用法：[CLI](/tooling/cli)
- 数据包生成：[构建数据包](/tooling/build-package)
