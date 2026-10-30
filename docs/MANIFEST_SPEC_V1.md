# WeiSQL Manifest V1 规范

- 状态：V1 基础结构已冻结
- 格式标识：`weisql`
- 格式版本：`1.0.0`
- 机器可读 Schema：`MANIFEST_SCHEMA_V1.json`

> 本文定义数据包公开协议，不是 DuckDB、USearch 或其他引擎的内部配置。若其他草案与本文冲突，以本文和正式 JSON Schema 为准。

## 1. 数据包布局

```text
weisql-package/
├── manifest.json
├── data/documents.parquet
└── vectors/
    ├── embeddings.f32
    ├── id-map.jsonl
    └── id-map.offsets
```

所有路径相对于 `manifest.json` 所在目录，必须在包根内。V1 使用多文件不可变数据包；`.wsql` 单文件容器尚未冻结。

### 1.1 格式、数据集与发布版本

| 概念 | 作用 | 示例 |
| --- | --- | --- |
| `formatVersion` | 数据包协议兼容性 | `1.0.0` |
| `datasetId` | 稳定数据集身份 | `product-docs` |
| 发布版本 | 一次不可变快照，由目录/入口层管理 | `v2026-10-30` |
| 文件 SHA-256 | 单个文件内容身份 | 64 位十六进制 |

数据内容更新不应改变 `formatVersion`。V1 Manifest 暂不内嵌发布版本字段；版本目录和入口指针由 Builder/部署层管理。未来若加入该字段，必须通过格式版本演进。

## 2. TypeScript 逻辑类型

```ts
interface WeiSQLManifest {
  format: "weisql";
  formatVersion: "1.0.0";
  datasetId: string;
  tables: TableDescriptor[];
  vectorCollections: VectorCollectionDescriptor[];
  metadata?: {
    title?: string;
    description?: string;
    createdAt?: string;
    builderVersion?: string;
  };
}
```

TypeScript 类型只帮助可信代码开发，不能验证下载的 JSON。所有外部 Manifest 必须经过运行时校验器。

## 3. 表定义

```ts
interface TableDescriptor {
  name: string;
  file: { path: string; bytes: number; sha256: string };
  format: "parquet";
  columns: Array<{
    name: string;
    type: "string" | "int32" | "int64" | "float32" |
          "float64" | "boolean" | "timestamp" | "date" | "json";
    nullable: boolean;
  }>;
  primaryKey: string[];
}
```

约束：

- 表名在包内唯一并符合标识符规则；
- 列名在表内唯一并符合标识符规则；
- 至少有一列和一个主键列；
- 主键成员唯一且必须引用已声明列；
- V1 表文件格式固定为 Parquet。

## 4. 向量集合

```ts
interface VectorCollectionDescriptor {
  name: string;
  tableName: string;
  idColumn: string;
  count: number;
  dimension: number;
  metric: "cosine" | "l2" | "ip";
  encoding: "f32-le-row-major";
  data: FileDescriptor;
  idMap: IdMapDescriptor;
  index?: {
    engine: string;
    version: string;
    file: FileDescriptor;
    params?: Readonly<Record<string, number>>;
  };
}
```

- `tableName` 必须引用存在的表；
- `idColumn` 必须引用该表的主键列；
- `count` 是非负安全整数，允许空集合；
- `dimension` 是正安全整数；
- Float32 使用小端、row-major 连续编码；
- `data.bytes` 必须等于 `count × dimension × 4`，计算使用 BigInt 防止溢出；
- 引擎索引是可选派生资源，不属于跨引擎公共数据语义；
- `index.params` 是引擎相关构建参数的扁平数字表（参数名须为标识符，最多 32 项）。V1 不把它拆成具体字段，因为 `engine` + `version` 已确定解释方式；加载方无法重建参数时必须拒绝加载，而不是猜测。USearch 目前使用 `connectivity`、`expansion_add`、`expansion_search`。

距离统一为越小越相似：Cosine 为 `1 - similarity`，L2 为欧氏距离，IP 为负内积。

## 4.1 全文索引（可选）

```ts
interface TextIndexDescriptor {
  name: string;
  tableName: string;
  column: string;        // 必须是 string 或 json 列
  idColumn: string;      // 必须是该表主键列
  documentCount: number; // ≥ 1
  termCount: number;     // ≥ 1
  averageDocumentLength: number;
  data: FileDescriptor;        // terms.jsonl
  termOffsets: FileDescriptor; // u64-le，数量 = termCount
  docLengths: FileDescriptor;  // u32-le，数量 = documentCount
  idMap: IdMapDescriptor;      // 行 → 业务 ID，count 必须等于 documentCount
  k1?: number; // 默认 1.2
  b?: number;  // 默认 0.75，范围 [0, 1]
}
```

- `documentCount` 与 `averageDocumentLength` 是**声明值**，运行时不重新统计：BM25 查询不应扫描全库；
- `termOffsets.bytes` 必须等于 `termCount × 8`，`docLengths.bytes` 必须等于 `documentCount × 4`；
- 三个文件都参与 L3 校验，路径与其他资源一样必须全局唯一；
- 格式与评分语义见 `FULL_TEXT_SEARCH.md`。

## 5. ID Map 与偏移索引

```ts
interface IdMapDescriptor {
  data: FileDescriptor & { format: "jsonl" };
  offsets: FileDescriptor & { format: "uint64-le" };
  count: number;
  uniqueIds: boolean;
}
```

`id-map.jsonl` 使用 UTF-8，每行一个 `{ "row": number, "id": string | safe-integer }`。行号从 0 连续递增，第 N 行对应第 N 条向量。文件末尾允许一个换行符。

`id-map.offsets` 为每条 JSONL 记录保存起始字节位置，每项是 little-endian UInt64：

- 长度严格为 `idMap.count × 8`；
- 第一项为 0；
- 偏移严格递增且不超过 JSONL 文件长度；
- 转换为 JavaScript number 前必须检查安全整数范围；
- 中间记录以下一项作为结束位置，最后一条以 `idMap.data.bytes` 作为结束位置。

`idMap.count` 必须等于向量 `count`。`uniqueIds: true` 表示 Builder 必须验证业务 ID 唯一。

## 6. 文件描述与路径安全

每个文件描述包含：

- `path`：1–1024 字符的规范相对路径；
- `bytes`：非负安全整数；
- `sha256`：64 位十六进制摘要。

路径规则：

- 只使用 `/`；
- 拒绝绝对路径、盘符、URL scheme、反斜杠、NUL、空路径段、`.` 和 `..`；
- 拒绝所有 `%`，避免 URL 解码和平台差异；
- 查询字符串 `?` 和片段 `#` 不在允许字符集内，必须拒绝；
- 所有资源路径在整个数据包内唯一；
- Node 文件 Reader 和 HTTP Reader 仍须进行包根 containment 与重定向检查。

## 7. 四层校验

| 层级 | 内容 | 默认时机 |
| --- | --- | --- |
| L1 结构 | JSON 类型、必填字段、未知字段、版本 | `open()` |
| L2 语义 | 名称、引用、路径、计数和字节公式 | `open()` |
| L3 内容 | 实际长度、SHA-256、JSONL/偏移对应 | 按验证策略或 Builder 发布时 |
| L4 引擎 | Parquet 可读性、索引兼容性 | 首次使用对应能力 |

SHA-256 只能证明内容与 Manifest 声明一致，不能证明发布者可信。来源真实性需要可信分发或未来签名机制。

### 7.1 资源限制

Runtime 在解析或分配前必须应用可配置限制：

- Manifest 最大字节数；
- 表、向量集合和资源文件数量；
- 单文件及数据包声明总字节数；
- 最大向量维度、记录数和 Top-K；
- 路径长度和错误列表上限。

具体默认值尚未通过真实数据验证，因此不在 V1 格式中硬编码。实现必须提供安全默认值并允许受信任调用方调整，超限返回 `INVALID_ARGUMENT` 或未来冻结的资源限制错误，不能尝试不受控分配。

## 8. Builder 一致性要求

Builder 发布前必须：

1. 写出规范 Parquet、Float32、JSONL 和偏移文件；
2. 使用实际文件计算 `bytes` 和 SHA-256；
3. 验证向量与 ID Map 计数一致；
4. 验证 JSONL 行号连续、ID 唯一策略及 ID 在目标表中存在；
5. 验证偏移索引严格对应 JSONL 记录边界；
6. 生成 Manifest 后重新通过 Runtime 的 L1/L2 校验；
7. 在发布验收中由 Runtime 重新打开产物并执行 SQL 与向量查询。

### 8.1 V1 结构安全上限

以下限制属于格式校验的防御性边界，不是性能承诺：

- `datasetId` 长度为 1–128，只允许字母、数字、点、下划线和连字符，并以字母或数字开头；
- 表名、列名、向量集合名及其引用最长 128 个字符；
- `tables`、`vectorCollections` 和单表 `columns` 各不超过 10,000 项；
- 向量 `dimension` 范围为 1–65,536；
- 所有字节数和计数必须是 JavaScript 安全整数；
- 主键至少包含一列，引用已声明、互不重复且不可为空的列；
- 每个文件描述必须包含 `bytes` 和 SHA-256。

Runtime 还应提供更严格且可配置的单资源、总下载量和内存预算。调用方放宽运行时预算不会放宽上述格式规则。

## 9. 当前实现状态

截至 2026-10-30，正式 TypeScript 类型、JSON Schema、L1/L2 运行时校验、路径校验、向量字节公式和 ID 偏移大小校验已迁移到本结构并有自动化测试。

尚未完成 Builder、实际文件 SHA-256/长度验证、Parquet 内容校验、全量 ID 唯一性及主键存在性扫描。不得把这些未实现能力描述为已完成。

