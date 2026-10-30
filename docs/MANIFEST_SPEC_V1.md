# WeiSQL AI Manifest V1 规范

- 状态：设计基线草案
- 目标版本：`1.x.y`
- 适用范围：多文件静态数据包；未来 `.wsql` 容器必须复用相同逻辑数据模型

> 本文是目标规范，不代表仓库中的 Schema、运行时校验器或资源加载器已经完整实现。当前实现差异见第 10 节。

## 1. 角色与边界

Manifest 是数据包的稳定描述契约，不依赖 DuckDB、USearch 或其他引擎的内部类型。它描述表、原始向量数据、可选索引以及资源完整性信息。

Manifest 结构校验和真实资源完整性校验是两个独立阶段：

1. 结构校验检查字段、类型、版本、引用、路径与静态约束；
2. 资源校验读取实际文件，检查字节数、SHA-256 和格式特定约束。

结构校验成功不表示资源真实存在或内容完整。

## 2. 示例

```json
{
  "format": "weisql-ai",
  "formatVersion": "1.0.0",
  "datasetId": "biology-knowledge",
  "createdAt": "2026-10-30T12:00:00Z",
  "tables": [
    {
      "name": "documents",
      "schema": [
        { "name": "id", "type": "utf8", "nullable": false },
        { "name": "title", "type": "utf8", "nullable": false },
        { "name": "content", "type": "utf8", "nullable": true },
        { "name": "category", "type": "utf8", "nullable": true }
      ],
      "primaryKey": ["id"],
      "files": [
        {
          "path": "records/documents.parquet",
          "format": "parquet",
          "bytes": 102400,
          "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "rows": 100
        }
      ]
    }
  ],
  "vectors": [
    {
      "name": "document_embedding",
      "sourceTable": "documents",
      "idColumn": "id",
      "dimension": 384,
      "elementType": "float32",
      "metric": "cosine",
      "data": {
        "path": "vectors/embeddings.f32",
        "layout": "row-major",
        "count": 100,
        "bytes": 153600,
        "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
      },
      "index": {
        "engine": "usearch",
        "engineVersion": "TBD",
        "path": "indexes/documents.usearch"
      }
    }
  ]
}
```

示例摘要仅用于展示字段形状，不代表真实文件内容。

## 3. 版本兼容规则

- `format` 必须为 `weisql-ai`。
- `formatVersion` 使用语义化版本 `major.minor.patch`。
- V1 读取器接受其明确支持的 `1.x.y` 版本；不得仅因主版本相同而盲目接受未知语义。
- 删除字段、改变既有字段含义或引入无法安全忽略的行为必须升主版本。
- 向后兼容的新字段或约束澄清可升次版本；不影响语义的修订可升补丁版本。
- 不支持的主版本返回 `FORMAT_VERSION_UNSUPPORTED`，不得尝试猜测或降级解析。

SDK 应公开其支持的 Manifest 版本范围。

## 4. 标识符与引用

- `datasetId` 长度为 1–128 个字符。
- 表名必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`，且在数据包内唯一。
- 同一表内列名必须唯一；向量名称在数据包内唯一。
- `primaryKey` 中每一项必须引用已声明列，成员不得重复。
- V1 允许复合主键用于 SQL 表语义，但向量 `idColumn` 必须引用一个可独立、稳定标识记录的列。若表只有复合键而不存在这样的列，Builder 必须生成独立 ID 列。
- `sourceTable` 必须引用已声明表；`idColumn` 必须引用该表的已声明列。
- 公共业务 ID 不得依赖文件行号或向量引擎内部整数 ID。

## 5. 表与文件

表至少包含一个列和一个数据文件。V1 列类型为：

```text
utf8 | int32 | int64 | float32 | float64 | boolean | binary | timestamp
```

文件约束：

- `path` 为安全相对路径；
- `format` 明确实际编码，例如 `parquet`；
- `bytes` 是非负 JavaScript 安全整数；
- `rows` 如存在，是非负 JavaScript 安全整数；
- `sha256` 是实际内容的 64 位十六进制 SHA-256；
- 所有资源经过规范化后的路径在整个数据包内唯一。

## 6. 向量数据

向量数据使用专用 `data` 对象，不以普通 `files[]` 代替。V1 未定义向量分片；需要分片时必须先扩展规范和兼容性测试。

`data` 必须包含：

- `path`：原始向量资源路径；
- `layout`：V1 固定为 `row-major`；
- `count`：向量数量，非负安全整数；
- `bytes`：资源字节数，非负安全整数；
- `sha256`：资源内容摘要。

向量本身必须声明：

- `dimension`：大于 0 的安全整数；
- `elementType`：V1 固定为 `float32`；
- `metric`：`cosine`、`l2` 或 `ip`。

对未压缩、row-major、Float32 数据：

```text
expectedBytes = count × dimension × 4
```

校验器必须使用防溢出的安全整数运算，并要求 `data.bytes === expectedBytes`。资源加载后还要验证实际文件长度等于 `data.bytes`。未来的量化、压缩或其他布局必须通过明确编码字段扩展，不能沿用 Float32 公式。

向量数量与源表行数不必天然相等，但 Builder 必须提供稳定的业务 ID 映射；不得仅假定两个文件的行顺序永久一致。

V1 使用 `tableName` 明确源表，并使用独立 `idMap` 资源保存逐行业务 ID。`idMap.format` 为 `jsonl`，每行是 `{ "row": 非负整数, "id": 字符串或安全整数 }`。第 N 行必须声明 `row: N` 并对应第 N 条向量；`idMap.count` 必须等于 `data.count`。业务 ID 默认必须唯一。

Builder 必须验证每个 ID 能在目标表的 `idColumn` 中找到。该检查属于构建期完整性验证；浏览器 Runtime 打开数据包时不应默认扫描整张 Parquet 表。JSONL 不承诺高效随机访问，百万级映射是否改为二进制或分块格式必须依据实测决定。

## 7. 可选向量索引

索引是可重建的派生资源，不是原始数据的替代品。`index` 如存在，应包含：

- `engine`：索引引擎名称；
- `engineVersion`：生成索引的引擎版本；
- `path`：索引资源路径；
- `sha256`：建议提供；正式发布前是否强制由后续版本决策冻结。

Runtime 只有在能力声明与版本策略允许时才能加载索引。索引缺失或不兼容时，必须按显式策略执行精确搜索回退或返回 `INDEX_NOT_FOUND`，不能静默忽略。

## 8. 路径与未知字段

资源路径必须：

- 使用 `/` 分隔；
- 相对于 Manifest 所在目录；
- 拒绝绝对路径、空段、`.`、`..`、反斜杠、盘符和 URL scheme；
- 在解码和规范化后再次进行安全校验；
- 禁止重复的规范化路径。

V1 核心对象采用封闭字段集合，未知核心字段导致 `MANIFEST_INVALID`，防止拼写错误被静默接受。非关键、自描述扩展应放在允许自由键值的 `metadata` 对象。需要影响 Runtime 行为的扩展必须进入后续正式版本，不能隐藏在 `metadata` 中。

## 9. 错误与校验顺序

建议顺序：

1. 限制 Manifest 下载字节数；
2. 解析 JSON；
3. 校验格式标识和版本；
4. 校验字段与数值限制；
5. 校验路径和跨字段引用；
6. 解析资源位置；
7. 按验证策略检查实际字节数和 SHA-256；
8. 最后打开 SQL 或向量引擎。

版本不支持返回 `FORMAT_VERSION_UNSUPPORTED`；不安全路径可返回 `PATH_INVALID`；其他结构或引用错误返回 `MANIFEST_INVALID`；实际资源不匹配返回 `RESOURCE_INTEGRITY_FAILED`。

## 10. 当前实现差异

截至 2026-10-30：

- `MANIFEST_SCHEMA_V1.json` 和 TypeScript 校验器仍使用向量 `files[]`，尚未迁移到本规范的 `data`；
- 校验器尚未验证真实资源的长度与 SHA-256；
- 向量业务 ID 映射格式尚未冻结；
- 未知核心字段当前已拒绝，`metadata` 可承载非关键扩展；
- 本文中的目标结构必须先同步更新 Schema、类型、样例和测试，才能声明为已实现。

## 11. 数据包目录与部署

逻辑目录示例：

```text
weisql-package/
├── manifest.json
├── data/
│   └── documents.parquet
├── vectors/
│   └── embeddings.f32
└── indexes/
    └── vector.index
```

- `manifest.json` 是数据包入口，描述格式版本、表、向量和资源；
- `data/` 保存供 SQL 引擎读取的结构化文件；
- `vectors/` 保存可选的原始向量数据；
- `indexes/` 保存可选、引擎相关且可重建的 ANN 索引。

目录只是逻辑约定，资源均相对于 `manifest.json` 所在位置解析。多文件设计应允许 Runtime 按需读取，避免浏览器打开数据包时一次性下载全部内容。文件能否被浏览器中的具体引擎直接读取，必须通过 CORS、HTTP Range、缓存和运行时兼容性测试验证。

## 12. Runtime 四层校验流水线

校验分层以避免 `open()` 不必要地下载全部大型资源。

### 第 1 层：Manifest 结构校验

检查必填字段、格式版本、字段类型、额外字段、重复表名、重复列名和基础数值限制。此阶段不下载资源文件。

### 第 2 层：资源声明校验

检查路径安全与冲突、文件大小声明、向量维度、向量字节数公式、主键和资源间引用关系。此阶段仍不要求读取资源内容。

### 第 3 层：实际资源校验

按验证策略检查 HTTP 响应、实际字节数与 SHA-256。大文件应采用流式哈希，避免为校验而将整个资源同时驻留内存。HTTP 缓存命中不能视为内容已经验证。

### 第 4 层：引擎可读性校验

SQL 或 Vector Adapter 确认文件格式、索引版本、运行时兼容性和查询能力。结构正确的文件仍可能无法被当前引擎读取。

默认时机：

| 操作 | 默认校验层级 |
| --- | --- |
| `open()` | 第 1、2 层 |
| 首次访问资源 | 按 `verifyChecksums` 策略执行第 3 层 |
| 首次使用 SQL/Vector 能力 | 执行第 4 层 |
| 安全敏感场景 | 资源使用前强制执行第 3 层 SHA-256 校验 |

SHA-256 只能证明文件与 Manifest 中的摘要一致，不能证明摘要或发布方可信。来源真实性需要可信分发渠道或未来的签名机制。

## 13. Manifest 自动化测试矩阵

| 测试组 | 必须覆盖的场景 | 预期结果 |
| --- | --- | --- |
| 版本 | 不支持主版本、错误格式标识 | 明确拒绝打开 |
| Schema | 缺字段、错误类型、未知核心字段 | `MANIFEST_INVALID` |
| 路径 | `../secret`、绝对路径、URL scheme、重复规范化路径 | `PATH_INVALID` 或结构校验错误 |
| 表结构 | 重复表名、重复列名、主键列不存在 | 可读的校验问题列表 |
| 向量结构 | 零维、计数无效、字节数公式不匹配 | `MANIFEST_INVALID` 或资源声明错误 |
| 完整性 | 实际长度或 SHA-256 不匹配 | `RESOURCE_INTEGRITY_FAILED` |
| 网络 | 404、超时、CORS、Range 不支持 | 可诊断的资源错误 |
| SQL | 无 Adapter、初始化失败 | 明确错误，不伪造结果 |
| 向量请求 | 零向量、NaN、Infinity、维度不匹配 | 稳定向量错误码 |
| 生命周期 | 关闭后继续查询 | `DATABASE_CLOSED` |

错误码以 `SDK_API_CONTRACT_V1.md` 为准。附件草案中的 `CHECKSUM_MISMATCH` 统一映射为现行公共错误码 `RESOURCE_INTEGRITY_FAILED`，避免同一语义出现两套名称。

## 14. 建议的模块边界

随着职责增长，建议从当前单一 SDK 包逐步拆分为以下逻辑模块；是否形成独立 npm workspace 应以实际复用需求决定，不要求立即重构：

```text
packages/
├── manifest/
│   ├── schema/
│   ├── src/validate.ts
│   ├── src/paths.ts
│   ├── src/integrity.ts
│   └── tests/
├── runtime/
│   ├── src/open.ts
│   ├── src/database.ts
│   ├── src/errors.ts
│   └── tests/
└── adapters/
    ├── duckdb/
    └── vector/
```

Rust Core 继续保留为独立 crate。示例应至少覆盖 Node.js 只读查询和静态网站两种场景。

## 15. 待冻结的候选字段形状

新增的 `MANIFEST_SCHEMA_V1_CANDIDATE.json` 完整记录了本轮附件提出的候选结构，包括：

- `format` 使用 `weisql`；
- 表使用单个 `path/format/bytes/sha256/columns`；
- 向量的 `dimension` 位于 `data` 内；
- 向量编码使用 `f32-le-row-major`；
- 向量使用 `tableName` 引用源表，并以 `idMap` JSONL 资源映射业务 ID；
- `index` 是必填的对象或 `null`。

该候选与当前基线存在不兼容差异，尚未取代 `MANIFEST_SCHEMA_V1.json`。冻结前必须决定：

1. 格式标识采用 `weisql-ai` 还是 `weisql`；
2. 一张表是否允许多个文件/分片；
3. 列类型采用引擎无关小写类型还是 DuckDB 风格类型；
4. 百万级数据是否需要二进制或分块 ID 映射扩展；
5. `index` 缺省与显式 `null` 是否具有相同含义；
6. 空向量数据集是否允许 `count = 0`。

在这些问题形成 ADR 并同步更新 Schema、TypeScript 类型、校验器、样例和测试之前，候选 Schema 仅用于评审，不用于 Runtime 验证。

