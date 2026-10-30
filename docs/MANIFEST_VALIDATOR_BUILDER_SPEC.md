# Manifest Validator 与 WeiSQL Builder 工程规范

- 文档版本：V0.2
- 适用格式：WeiSQL Manifest V1 `1.0.0`
- 状态：Validator L1/L2 已实现；Builder 与 L3 文件验证待实现

本文将 Manifest 校验、资源路径安全、Builder 生成流程、错误处理和测试验收转化为可执行要求。Manifest 字段形状以 `MANIFEST_SPEC_V1.md` 和 `MANIFEST_SCHEMA_V1.json` 为准。

## 1. 工程目标与边界

本阶段涉及两个模块：

- **Manifest Validator**：将不可信 JSON 转换为经过验证的 `WeiSQLManifest`，检查结构、引用、资源声明和路径安全；
- **WeiSQL Builder**：接收已有 Parquet 和向量记录，在临时目录生成完整、可复验、可原子发布的数据包。

本规范不表示 DuckDB/WASM Adapter、ANN 索引构建、CSV/JSON 转 Parquet、Rust/WASM Runtime 或写事务已经实现。

## 2. 数据包产物

```text
weisql-package/
├── manifest.json
├── data/
│   └── documents.parquet
└── vectors/
    ├── embeddings.f32
    ├── embeddings.id-map.jsonl
    └── embeddings.id-map.offsets
```

| 文件 | 编码与职责 |
| --- | --- |
| `manifest.json` | UTF-8 JSON；数据集身份、表、向量集合和资源描述 |
| `*.parquet` | 结构化表数据，由 SQL Adapter 读取 |
| `*.f32` | little-endian Float32，row-major |
| `*.id-map.jsonl` | UTF-8 JSONL，每行 `{row,id}` |
| `*.id-map.offsets` | 每条 JSONL 记录起点，little-endian UInt64 |

示例中的文件长度与 SHA-256 只能是展示占位。Builder 必须使用实际输出重新计算。

## 3. 四层校验模型

| 层级 | 检查内容 | 是否读取资源 | 当前状态 |
| --- | --- | --- | --- |
| L1 结构 | JSON 类型、必填字段、未知字段、固定版本 | 否 | 已实现 |
| L2 语义 | 名称唯一、主键、引用、路径、计数与字节公式 | 否 | 已实现 |
| L3 内容 | 文件存在、实际长度、SHA-256、JSONL/偏移一致性 | 是 | 待实现 |
| L4 引擎 | Parquet 可读、引擎索引可加载 | 由 Adapter 决定 | 待实现 |

L1/L2 通过不能证明文件存在、内容正确或发布者可信。L3 通过也只能证明文件与 Manifest 摘要一致；发布者身份需要可信分发或未来签名机制。

## 4. Validator 可执行要求

### 4.1 不可信输入

- 入口类型必须为 `unknown`；
- `null`、数组和基本类型不能作为对象；
- 不允许通过 TypeScript 断言跳过验证；
- V1 核心对象拒绝未知字段；
- 可选字段缺省合法，但一旦提供就必须验证完整类型和语义；
- 不支持的版本返回 `FORMAT_VERSION_UNSUPPORTED`，不得静默降级。

### 4.2 数值和摘要

- `bytes`、`count` 和偏移声明必须是非负安全整数；
- `dimension` 必须是正安全整数；
- 拒绝 `NaN`、Infinity、负数、小数和超出安全范围的整数；
- SHA-256 必须是 64 位十六进制字符串；
- 跨字段乘法使用 BigInt，计算完成后检查 JavaScript 安全整数范围。

### 4.3 表和引用

- 表名、表内列名和向量集合名分别唯一；
- 表至少有一列和一个主键成员；
- 主键成员必须引用已声明列；
- `tableName` 必须引用已声明表；
- `idColumn` 必须引用目标表的主键列；
- 所有资源路径在数据包内全局唯一。

### 4.4 向量与 ID Map 声明

```text
vectorBytes = count × dimension × 4
offsetBytes = count × 8
```

- `count = 0` 合法，此时向量与偏移声明均为 0 字节；
- `idMap.count` 必须等于向量集合 `count`；
- 向量编码固定为 `f32-le-row-major`；
- ID 数据格式固定为 `jsonl`；
- 偏移格式固定为 `uint64-le`。

## 5. 路径安全策略

### 5.1 词法规则

| 路径 | 结果 | 原因 |
| --- | --- | --- |
| `data/documents.parquet` | 允许 | 规范相对路径 |
| `vectors/embeddings.f32` | 允许 | 规范相对路径 |
| `../secret.txt` | 拒绝 | 路径穿越 |
| `/etc/passwd` | 拒绝 | 绝对路径 |
| `C:/secret.txt` | 拒绝 | Windows 盘符 |
| `data\file.parquet` | 拒绝 | 反斜杠 |
| `data//file.parquet` | 拒绝 | 空路径段 |
| `data/./file.parquet` | 拒绝 | 非规范路径段 |
| `data/%2e%2e/secret` | 拒绝 | 百分号编码 |
| `https://example.test/data` | 拒绝 | URL scheme |

V1 路径长度为 1–1024，并直接拒绝所有 `%`，避免 URL 解码、代理和平台实现产生歧义。

### 5.2 Node.js 文件 containment

词法合法不代表文件系统安全。`NodeFileResourceReader` 和 Builder 必须：

1. 使用显式数据包根目录；
2. 将相对路径解析到根目录下；
3. 对根目录和目标执行真实路径检查；
4. 验证目标仍位于真实根目录之内；
5. 拒绝指向包外的符号链接或 junction；
6. 验证最终目标是预期文件类型；
7. Builder 不跟随输出目录中的不可信符号链接；
8. 对存在不可信并发写入者的环境评估 TOCTOU，并优先使用文件句柄级操作。

### 5.3 浏览器 URL containment

浏览器 Reader 使用受控的 HTTP(S) 基准 URL。解析后和重定向后都必须检查 origin 与基准路径 containment。Range 响应必须验证 `206`、`Content-Range` 和实际长度。

## 6. L3 文件完整性验证

L3 接口至少接收 `ResourceReader`、文件描述和验证策略，执行：

1. `stat()` 或实际读取长度与 `bytes` 比较；
2. 对完整字节流增量计算 SHA-256；
3. 以大小写无关的十六进制摘要比较；
4. 不匹配时返回 `RESOURCE_INTEGRITY_FAILED`；
5. 仅在资源身份、摘要和版本信息均匹配时复用验证缓存。

大文件不得仅为哈希而强制一次性驻留内存。按需 Range 查询不能被描述为“已经完成整文件 SHA-256 验证”。

ID Map 内容验证还包括：

- JSONL 是有效 UTF-8；
- 行号从 0 连续递增；
- ID 非空且类型为字符串或安全整数；
- `uniqueIds: true` 时 ID 不重复；
- 偏移文件长度为 `count × 8`；
- 第一项为 0，偏移严格递增并不超过 JSONL 长度；
- 每个偏移实际指向对应 JSON 记录起点。

## 7. 向量内容验证

- Float32 按小端显式解码；
- 每个值必须有限；
- 文件长度必须与声明公式一致；
- Cosine 集合拒绝零向量；
- 向量行号与 ID Map 一一对应；
- ID 在集合内的唯一性由 `uniqueIds` 决定；
- ID 是否真实存在于 Parquet 主键列属于 Builder/L4 交叉验证。

距离语义统一为：Cosine `1 - similarity`、L2 欧氏距离、IP 负内积，均按升序排列。

## 8. Builder 输入和边界

V1 Builder 首个版本接收：

- 已存在且声明明确的 Parquet 文件；
- 向量记录及其业务 ID；
- 表列、主键、向量度量和数据集元数据配置。

首版不承诺 CSV/JSON 自动推断并生成 Parquet。该能力需要独立模块验证空值、时间、Decimal、大整数、类型推断和流式内存行为。

## 9. Builder 生成流程

| 阶段 | 操作 | 产物/结果 |
| --- | --- | --- |
| 1 初始化 | 校验配置、datasetId、输入和目标策略 | 构建上下文 |
| 2 创建暂存区 | 在目标同一文件系统创建唯一临时目录 | 私有构建目录 |
| 3 表处理 | 校验并复制已有 Parquet | 表文件与描述符 |
| 4 向量验证 | 检查维度、有限值、Cosine 零向量、重复 ID | 合法记录流 |
| 5 写向量 | 逐行写 little-endian Float32 | `.f32` |
| 6 写 ID Map | 写 JSONL，同时记录每行起始 UInt64 偏移 | `.jsonl`、`.offsets` |
| 7 计算描述 | 流式计算实际长度和 SHA-256 | FileDescriptor |
| 8 生成 Manifest | 使用冻结 V1 类型写 UTF-8 JSON | `manifest.json` |
| 9 复验 | 重新解析 Manifest，执行 L1/L2/L3 | 验证报告 |
| 10 发布 | 对完整暂存目录执行原子发布 | 不可变版本目录 |

## 10. 失败、覆盖和原子发布

Builder 不得在最终发布目录逐文件构建。

```text
输入 → 私有临时目录 → 生成全部资源 → 生成 Manifest
     → L1/L2/L3 复验 → 原子发布
                         ├─失败：清理暂存区
                         └─成功：切换版本入口
```

- 临时目录与目标应位于同一文件系统，以便使用原子重命名；
- 默认拒绝覆盖已有目标；
- 推荐发布到不可变版本目录，再原子切换入口引用；
- 如允许替换，必须验证精确目标并整体替换，不逐文件覆盖；
- 失败构建不得出现可被 Runtime 识别为完整包的最终入口；
- 清理失败应报告，但不能掩盖原始构建错误。

## 11. 错误和诊断

现有公共 SDK 使用稳定 `WeiSQLError`。Builder 不另造一套同义错误码。

| 场景 | 公共错误码 |
| --- | --- |
| Manifest 结构、文件描述或引用错误 | `MANIFEST_INVALID` |
| 不支持的格式版本 | `FORMAT_VERSION_UNSUPPORTED` |
| 不安全或越界路径 | `PATH_INVALID` |
| 文件不存在 | `RESOURCE_NOT_FOUND` |
| 网络、文件或流读取失败 | `RESOURCE_READ_FAILED` |
| 实际长度、摘要或数据内容不一致 | `RESOURCE_INTEGRITY_FAILED` |
| 非法向量值 | `VECTOR_INVALID_VALUE` |
| 向量维度不符 | `VECTOR_DIMENSION_MISMATCH` |
| 取消 | `QUERY_CANCELLED` |
| 关闭后使用 | `DATABASE_CLOSED` |
| 未预期的 Builder/Adapter 故障 | `INTERNAL_ERROR`，附安全诊断阶段 |

错误 `details` 可包含字段路径、datasetId、集合名、阶段和安全的底层原因，但不得包含 API Key、Authorization/Cookie、签名 URL 查询参数、完整记录或绝对私有路径。

## 12. 自动化测试矩阵

### 12.1 Validator

- 根值为 null、数组和基本类型；
- 嵌套对象缺失、类型错误和未知字段；
- NaN、Infinity、小数、负数和超安全整数；
- 无效 SHA-256；
- 重复表、列、集合和资源路径；
- 主键、表和 ID 列引用错误；
- 路径穿越、盘符、反斜杠、空段、URL 和任意 `%`；
- 向量与偏移字节数公式；
- 空向量集合；
- 不支持的格式版本。

### 12.2 Builder

- 小型正常数据包可生成并由 Runtime 重新打开；
- Float32 小端编码与预期字节逐项一致；
- JSONL 行号、ID 和 UInt64 偏移往返一致；
- 重复 ID、维度错误、非有限值和 Cosine 零向量被拒绝；
- 修改任意输出文件后 L3 失败；
- 中途注入写入失败后没有最终包入口；
- 已存在目标遵循明确覆盖策略；
- 符号链接或 junction 不能导致根外写入；
- 大文件使用流式写入与哈希，峰值内存有测试上限。

### 12.3 最终验收

| 项目 | 通过条件 |
| --- | --- |
| TypeScript | 严格类型检查通过 |
| 单元测试 | 全部通过，无跳过的安全用例 |
| 路径 | 词法和真实路径逃逸均被拒绝 |
| 完整性 | 正常包通过，截断或修改后失败 |
| 编码 | Float32、JSONL、UInt64 与规范一致 |
| 发布 | 失败构建不会暴露完整包入口 |
| 往返 | Builder 产物可由 Runtime 打开并得到相同业务 ID |
| 文档 | 已实现、已验证和待实现状态清晰 |

## 13. 当前状态与实施顺序

已实现并验证：

- 冻结 V1 TypeScript 类型和 JSON Schema；
- L1/L2 运行时校验；
- 严格资源路径词法校验；
- HTTP URL containment 与 Range 校验；
- Float32 与偏移字节公式；
- 分块向量读取、Indexed ID Map Reader 和精确搜索测试。

下一步：

1. 实现 Node 文件 Reader 的真实路径 containment；
2. 实现流式文件长度与 SHA-256 L3 验证；
3. 实现 Builder 临时目录、向量/ID 写入和摘要生成；
4. 建立三记录真实 Parquet fixture 与 Builder/Runtime 往返测试；
5. 再接入 DuckDB、DuckDB-Wasm 和性能基准。

