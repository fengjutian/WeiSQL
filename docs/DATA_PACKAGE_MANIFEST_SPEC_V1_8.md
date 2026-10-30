# WeiSQL AI 数据包格式与 Manifest 正式规范 V1.8

文档编号：WSAI-FORMAT-001 · 版本：V1.8 · 状态：规范草案 · 适用范围：WeiSQL AI V1

## 1. 设计目标

V1.8 定义 WeiSQL 数据包的稳定格式，使数据包可以被独立构建、验证、发布、缓存和读取，而不依赖某个特定 SQL 引擎或向量索引引擎的内部结构。

### 与当前仓库的差异

本文是**规范草案**。Manifest V1 的实际冻结形态以 [`MANIFEST_SPEC_V1.md`](MANIFEST_SPEC_V1.md) 与 [`MANIFEST_SCHEMA_V1.json`](MANIFEST_SCHEMA_V1.json) 为准——那两份已由实现与测试验证。已知出入：

| 本文的设计 | 当前仓库的实际状态 |
| --- | --- |
| `formatVersion` 示例写作 `"1.0"` | 实现要求 `"1.0.0"`（严格相等，否则 `FORMAT_VERSION_UNSUPPORTED`） |
| 文档版本号 V1.8 与数据包格式版本是两套编号 | 正确：文档版本不写入 Manifest，`formatVersion` 只描述数据包格式 |
| 向量索引的完整描述（含构建参数） | 未实现。Manifest `index` 字段目前只有 `{engine, version, file}`，缺 connectivity / expansion 等参数，因此无法复现同一索引 |
| 全文索引字段 | 已新增 `textIndexes`，见 [`FULL_TEXT_SEARCH.md`](FULL_TEXT_SEARCH.md) |

本文关于**分层原则**（数据层 / 索引层 / 描述层）与**路径安全**的部分已落地；字段级细节以 [`MANIFEST_SPEC_V1.md`](MANIFEST_SPEC_V1.md) 为准。

本规范遵循五项原则：

1. Manifest 是唯一入口：Runtime 从 Manifest 发现数据文件和功能能力。
2. 数据与索引分离：Parquet 和原始向量是数据，ANN 索引是可验证的加速结构。
3. 路径显式、格式可版本化：文件引用不得依赖隐式目录约定。
4. 完整性可以验证：文件长度、摘要、记录数量和跨文件关系必须一致。
5. 兼容性可以判断：旧 Runtime 能识别不支持的格式版本和索引后端。

本文中的 JSON 示例是规范设计，不代表已经冻结为最终代码 Schema。

## 2. 数据包布局

```
weisql-package/
├── manifest.json
├── data/
│   └── documents-00000.parquet
├── vectors/
│   └── document-embedding/
│       ├── vectors.f32
│       ├── id-map.jsonl
│       └── id-map.offsets
├── indexes/
│   └── document-embedding/
│       ├── index.bin
│       └── index-meta.json
└── metadata/
    ├── schema.json
    └── build-info.json
```

| 文件                | 性质         | 作用            |
| ----------------- | ---------- | ------------- |
| `manifest.json`   | 必需         | 数据包入口与结构描述    |
| `data/*.parquet`  | SQL 表必需    | 结构化记录         |
| `vectors.f32`     | 向量集合必需     | 原始 Float32 向量 |
| `id-map.jsonl`    | 向量集合必需     | 向量与数据记录之间的映射  |
| `id-map.offsets`  | 随机访问模式必需   | 快速定位映射记录      |
| `index.bin`       | 使用 ANN 时必需 | 引擎专用索引        |
| `index-meta.json` | 使用 ANN 时必需 | 索引参数和兼容信息     |
| `schema.json`     | 推荐         | Schema 独立副本   |
| `build-info.json` | 推荐         | 构建来源与诊断信息     |

如果数据包只包含 SQL 数据、不包含向量集合，可以省略 `vectors/` 和 `indexes/`。

## 3. Manifest 顶层结构

建议采用以下顶层字段：

| 字段                  | 类型     | 必需 | 含义           |
| ------------------- | ------ | -- | ------------ |
| `format`            | string | 是  | 固定为 `weisql` |
| `formatVersion`     | string | 是  | 数据包格式版本      |
| `dataset`           | object | 是  | 数据集身份和版本     |
| `files`             | array  | 是  | 唯一权威文件清单     |
| `tables`            | array  | 是  | SQL 表定义      |
| `vectorCollections` | array  | 否  | 向量集合定义       |
| `capabilities`      | object | 是  | 数据包声明的功能     |
| `integrity`         | object | 是  | 清单完整性策略      |
| `extensions`        | object | 否  | 有命名空间的扩展字段   |

### 3.1 格式版本和数据版本

必须区分：

- `formatVersion`：数据包结构和语义版本；
- `dataset.version`：具体数据内容的发布版本；
- Builder 版本：负责生成数据包的软件版本；
- 索引后端版本：负责生成专用索引的引擎版本。

修改文档内容但不改变数据包格式时，可以更新数据集版本，不必提高格式版本。

修改必需字段、距离语义或文件编码时，必须评估格式兼容性。

## 4. Manifest 完整示例

下面展示推荐的数据结构。正式 Schema 应锁定具体字段和验证规则。

```
{
  "format": "weisql",
  "formatVersion": "1.0",
  "dataset": {
    "id": "docs-dataset",
    "version": "2026-10-30.1",
    "createdAt": "2026-10-30T00:00:00Z"
  },
  "files": [
    {
      "id": "documents-part-0",
      "path": "data/documents-00000.parquet",
      "mediaType": "application/vnd.apache.parquet",
      "sizeBytes": 73400320,
      "sha256": "<64位十六进制SHA-256>"
    },
    {
      "id": "document-vectors",
      "path": "vectors/document-embedding/vectors.f32",
      "mediaType": "application/octet-stream",
      "sizeBytes": 614400000,
      "sha256": "<64位十六进制SHA-256>"
    },
    {
      "id": "document-id-map",
      "path": "vectors/document-embedding/id-map.jsonl",
      "mediaType": "application/x-ndjson",
      "sizeBytes": 40960000,
      "sha256": "<64位十六进制SHA-256>"
    },
    {
      "id": "document-id-offsets",
      "path": "vectors/document-embedding/id-map.offsets",
      "mediaType": "application/octet-stream",
      "sizeBytes": 800008,
      "sha256": "<64位十六进制SHA-256>"
    }
  ],
  "tables": [
    {
      "name": "documents",
      "schema": {
        "fields": [
          {
            "name": "document_id",
            "type": "utf8",
            "nullable": false
          },
          {
            "name": "content",
            "type": "utf8",
            "nullable": false
          }
        ]
      },
      "rowCount": 100000,
      "shards": [
        {
          "fileId": "documents-part-0",
          "rowCount": 100000,
          "rowIdStart": 0,
          "rowIdEndExclusive": 100000
        }
      ]
    }
  ],
  "vectorCollections": [
    {
      "name": "document-embedding",
      "table": "documents",
      "dimension": 768,
      "dtype": "float32",
      "byteOrder": "little-endian",
      "layout": "row-major",
      "metric": "cosine",
      "vectorCount": 100000,
      "vectorsFileId": "document-vectors",
      "idMapFileId": "document-id-map",
      "idMapOffsetsFileId": "document-id-offsets",
      "index": null
    }
  ],
  "capabilities": {
    "sql": true,
    "vectorSearch": true,
    "annSearch": false,
    "hybridSearch": true
  },
  "integrity": {
    "algorithm": "sha256",
    "verification": "required"
  }
}
```

示例中的摘要值只是占位符；正式数据包必须使用实际文件计算得到的摘要。示例还采用了不含 ANN 索引的精确搜索集合，因此 `annSearch` 为 `false`。

注意：这里的向量文件大小按照 100,000 × 768 × 4 计算，映射文件大小只是示意值，正式文件清单必须由实际产物生成，不能照抄示例。

## 5. 唯一权威文件清单

V1.8 建议采用 `files` 作为唯一权威文件登记表。其他结构通过 `fileId` 引用文件，而不是重复维护路径、大小和 SHA-256。

### 5.1 文件登记规则

每个文件条目必须具备：

- 全局唯一的 `id`；
- 包内相对路径 `path`；
- 明确的媒体类型 `mediaType`；
- 非负安全整数 `sizeBytes`；
- 64 位十六进制字符串形式的 SHA-256。

正式 Schema 还应约束：

- 路径唯一；
- ID 唯一；
- 文件引用必须能解析；
- 一个文件不能同时被赋予互相矛盾的语义；
- 未登记文件按严格模式处理；
- Manifest 自身不列入 `files`，避免自身摘要形成循环依赖。

### 5.2 路径规范

路径使用 POSIX 风格的相对路径，例如：

```
data/documents-00000.parquet
vectors/document-embedding/vectors.f32
```

禁止：

- 绝对路径；
- `..` 路径穿越；
- 反斜杠；
- NUL 字符；
- URL Scheme；
- 查询字符串与片段；
- 通过编码或规范化绕过检查的路径。

Node Runtime 必须在真实文件系统访问时额外检查符号链接和根目录边界，不能仅依靠字符串检查。

## 6. SQL 表与 Parquet 分片

### 6.1 Schema 语义

Schema 必须明确字段名、类型和可空性。V1 应冻结支持的基础类型映射，例如：

| WeiSQL 类型   | 含义        |
| ----------- | --------- |
| `bool`      | 布尔值       |
| `int32`     | 32 位整数    |
| `int64`     | 64 位整数    |
| `float32`   | 单精度浮点数    |
| `float64`   | 双精度浮点数    |
| `utf8`      | UTF-8 字符串 |
| `binary`    | 二进制数据     |
| `date`      | 日期        |
| `timestamp` | 时间戳       |
| `decimal`   | 定点十进制     |

最终实现必须把这些逻辑类型映射到真实 Parquet Schema，并定义 Timestamp 单位、时区、Decimal 精度与 Scale 的规则。

### 6.2 分片一致性

对于每个表：

\\[ \text{rowCount}=\sum_i\text{shards}\_i.\text{rowCount} \\]

并且必须满足：

- 分片引用有效；
- 分片之间没有重叠；
- `rowIdStart` 和 `rowIdEndExclusive` 连续；
- 区间长度与分片行数相等；
- 实际 Parquet 行数与声明相同。

Manifest 的 Schema 声明与实际 Parquet Schema 必须兼容；不能因为字段名称相同就忽略类型不一致。

## 7. 向量集合格式

每个向量集合必须声明：

- `dimension`；
- `dtype`；
- `byteOrder`；
- `layout`；
- `metric`；
- `vectorCount`；
- 向量文件、ID 映射文件和可选索引文件的引用。

V1 固定：

- `dtype = float32`；
- `byteOrder = little-endian`；
- `layout = row-major`。

向量文件长度必须满足：

\\[ \text{sizeBytes}=\text{vectorCount}\times\text{dimension}\times4 \\]

### 7.1 距离度量

| `metric` | 距离定义                                    | 排序 |
| -------- | --------------------------------------- | -- |
| `cosine` | \\(1-\operatorname{cosineSimilarity}\\) | 升序 |
| `l2`     | 欧氏距离                                    | 升序 |
| `ip`     | 负内积                                     | 升序 |

所有引擎适配器必须遵循公共语义。后端如果返回的是相似度分数，应在适配器中转换，不得直接把不同语义的分数混合到公共 API。

## 8. ANN 索引元数据

ANN 索引是可选加速结构，但一旦 Manifest 声明存在，就必须通过验证。

建议 `index-meta.json` 包含：

```
{
  "formatVersion": "1.0",
  "backend": "usearch",
  "backendVersion": "<validated-version>",
  "dimension": 768,
  "metric": "cosine",
  "indexedCount": 100000,
  "parameters": {
    "connectivity": 16,
    "expansionAdd": 200,
    "expansionSearch": 64
  },
  "sourceVectorsSha256": "<实际向量文件SHA-256>"
}
```

必须验证索引维度、度量、记录数量、后端版本和源向量摘要。索引元数据本身不是索引有效性的充分证据；验证器还必须使用目标后端重新加载索引。

如果 ANN 索引缺失或不兼容，Runtime 只能在明确支持精确搜索回退时执行回退，否则必须报告能力不可用。

## 9. 能力声明与兼容策略

Manifest 的 `capabilities` 描述数据包可提供的功能，而 Runtime 的 `capabilities()` 描述当前运行环境实际支持的功能。

两者需要取交集：

\\[ C\_{\text{effective}}=C\_{\text{package}}\cap C\_{\text{runtime}} \\]

例如，数据包包含 ANN 索引，但当前浏览器没有对应索引适配器，则不能宣称 ANN 已可用。

### 9.1 格式兼容规则

- 新增可选字段：在不改变既有语义的情况下，可以保持同一兼容版本。
- 新增必需字段：评估是否构成不兼容变更。
- 修改向量距离语义：属于重大兼容风险，必须更新格式或能力版本。
- 修改二进制编码：必须引入可区分的编码版本。
- 未知扩展：只有在明确为可忽略扩展时才能忽略。
- 未知必需功能：Runtime 必须拒绝打开或明确禁用相关能力。

不能只依靠语义版本字符串自动推断所有兼容性；最终还需要字段级 Schema 与能力检查。

## 10. 完整性验证顺序

推荐按照以下顺序执行：

1. 读取并解析 `manifest.json`。
2. 校验 Manifest Schema。
3. 校验格式版本与 Runtime 兼容性。
4. 验证路径规范与唯一性。
5. 验证所有引用的文件均已登记。
6. 检查文件实际长度。
7. 计算并比较 SHA-256。
8. 检查 Parquet Schema、行数和分片区间。
9. 检查向量字节长度、维度和数值。
10. 检查 ID 映射与 SQL 行的关系。
11. 检查索引可加载性和元数据一致性。
12. 使用目标 Runtime 执行冒烟查询。

SHA-256 验证必须覆盖完整文件内容。对于大型文件，可以流式计算摘要，避免一次性把整个文件读入内存。

## 11. 签名与信任边界

V1.8 只定义完整性，不把 SHA-256 当作发布者认证。

攻击者若同时修改数据和 Manifest 中的摘要，仍然可能构造出自洽的数据包。因此：

- 哈希用于检测文件与声明不一致；
- 签名用于验证发布者身份和清单完整性；
- 可信公钥分发、轮换与撤销必须另行设计。

后续版本可以增加签名清单，但必须明确签名覆盖范围，避免出现签名文件自身的循环依赖。

## 12. 正式 Schema 的实现要求

进入编码阶段后，应为 Manifest 提供机器可校验的 Schema 文件，例如：

```
packages/manifest/
├── src/
│   ├── schema.ts
│   ├── validate.ts
│   ├── compatibility.ts
│   └── paths.ts
├── schema/
│   └── manifest-v1.schema.json
└── tests/
    ├── valid-manifest.test.ts
    ├── invalid-manifest.test.ts
    └── compatibility.test.ts
```

JSON Schema 负责结构约束；TypeScript 验证器负责跨字段约束、文件存在性、哈希与实际资源检查。不能期望 JSON Schema 单独完成文件系统和索引后端验证。

## 13. V1.8 验收清单

- Manifest 顶层字段和类型已冻结。
- `files` 是唯一权威文件登记表。
- SQL 表、分片与行号区间可验证。
- 向量编码和距离语义明确。
- ID 映射规则与 V1.4 一致。
- ANN 索引元数据与后端兼容性可验证。
- 文件路径安全规则已实现。
- 完整 SHA-256 校验通过。
- 未知格式和必需扩展能正确拒绝。
- Node 与浏览器都能解析同一 Manifest。
- 所有示例中的占位摘要不会进入正式产物。
- JSON Schema 与 TypeScript 验证器拥有自动化测试。

## 14. 下一步文档路线

建议下一份是 《WeiSQL AI 公共 SDK API 与错误码正式冻结规范 V1.9》。

它将把 `open()`、SQL 查询、向量搜索、混合检索、分页、流式结果、能力声明、关闭语义和错误码统一冻结，确保 Builder、Node Runtime、浏览器 Runtime 与 Playground 使用同一套公共契约。

实施提醒： V1.8 仍是设计草案。应先把 Manifest Schema 和有效/无效测试夹具落到仓库，跑通实际验证器，再把它升级为已实现、已测试的正式规范。

