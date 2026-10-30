# WeiSQL 资源完整性校验规范

- 状态：V0.5 工程规范
- 适用格式：Manifest `1.0.0`
- 适用运行时：浏览器、Node.js

本文定义 Manifest 通过 L1 结构校验和 L2 语义校验后，Runtime 与 Builder 如何执行 L3 资源完整性校验。资源内容一律视为不可信输入。

## 1. 校验层级

| 层级 | 内容 | 当前状态 |
| --- | --- | --- |
| L1 | 类型、必填字段、未知字段、版本 | 已实现 |
| L2 | 唯一性、引用、路径、计数与字节公式 | 已实现 |
| L3 | 实际长度、SHA-256、ID Map 内容与偏移 | 部分实现，统一入口待完成 |
| L4 | Parquet 可读性、索引与引擎兼容性 | 待 Adapter 实现 |

结构校验器继续采用当前零运行时依赖的 TypeScript 实现，并以 `MANIFEST_SCHEMA_V1.json` 作为机器可读契约。若未来采用 Ajv 或预编译 Schema，必须运行同一套正反例和语义测试，且不得改变公开错误码。

## 2. ResourceReader 边界

完整性校验只依赖 `ResourceReader`，不直接依赖文件系统或 `fetch`。范围读取沿用左闭右开区间：

```ts
interface ResourceStat {
  size: number;
  etag?: string;
  lastModified?: string;
}

interface ResourceReader {
  stat(path: string, signal?: AbortSignal): Promise<ResourceStat>;
  readRange(
    path: string,
    range: { start: number; end: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  close(): Promise<void>;
}
```

这是目标契约；当前 Reader 已实现的能力以 `RESOURCE_READER_CONTRACT.md` 和源码为准。Node 文件 Reader、HTTP Reader 和未来 `.wsql` Reader 必须通过相同契约测试。

## 3. 完整性选项与报告

```ts
interface IntegrityOptions {
  verifySha256: boolean;
  maxResourceBytes: number;
  maxTotalBytes: number;
  signal?: AbortSignal;
}

interface IntegrityReport {
  checkedResources: number;
  sizeVerified: number;
  hashesVerified: number;
  totalDeclaredBytes: number;
}
```

报告必须区分“检查了声明”“验证了实际长度”和“完整读取并验证了哈希”。范围读取少量内容不得标记为哈希已验证。

建议提供三种打开策略：

- `none`：仅执行 L1/L2，不访问资源；
- `manifest`：检查路径、预算和实际长度，不完整读取大文件；
- `all`：执行完整 SHA-256 及格式专用检查。

策略名称进入公开 API 前还需完成双运行时测试；实现不得夸大实际验证级别。

## 4. 校验流程

对 Manifest 中每个唯一资源按以下顺序处理：

1. 再次验证规范相对路径；
2. 累加声明字节数，并在分配或读取前检查单资源和总预算；
3. 调用 `stat`，实际长度必须等于 `bytes`；
4. 在 `all` 模式下分块读取完整内容并计算 SHA-256；
5. 向量文件再次验证 `count × dimension × 4`；
6. ID Map 验证偏移数量、单调性、安全整数范围、JSONL 边界、连续行号和 ID 类型；
7. Builder 发布验收阶段再由 SQL Adapter 验证 Parquet 可读性。

所有乘法先使用 `BigInt` 或显式溢出检查。任何预算超限都必须在大内存分配前失败。取消操作映射为 `QUERY_CANCELLED`；长度、摘要和内容损坏映射为 `RESOURCE_INTEGRITY_FAILED`；路径问题映射为 `PATH_INVALID`。

SHA-256 证明资源与 Manifest 声明一致，不证明发布者身份。来源真实性依赖可信 HTTPS/CDN，未来如需离线信任应另行设计签名机制。

## 5. ID Map V1 内容规则

V1 的 `id-map.offsets` 保存 `count` 个 little-endian UInt64 起始位置，文件大小严格为 `count × 8`。第一项必须为 `0`；偏移严格递增且不超过 JSONL 文件长度。第 `i` 条记录的结束位置是下一项偏移，最后一条记录的结束位置是 `idMap.data.bytes`。空集合的偏移文件为零字节。

校验器必须确认每个范围恰好包含一条 UTF-8 JSONL 记录，记录形状为 `{ "row": number, "id": string | number }`，且 `row` 从 0 连续递增。`uniqueIds: true` 时 Builder 必须执行全量唯一性检查。

`count + 1` 个边界偏移是一项未来格式提案，不能与 V1 文件混用，详见 ADR-015。

## 6. 测试矩阵

| 场景 | 预期 |
| --- | --- |
| 实际大小与声明一致 | 通过长度校验 |
| 实际大小不符 | `RESOURCE_INTEGRITY_FAILED` |
| SHA-256 不符 | `RESOURCE_INTEGRITY_FAILED` |
| 单文件或总预算超限 | 读取和分配前失败 |
| 偏移数量、顺序或边界损坏 | `RESOURCE_INTEGRITY_FAILED` |
| JSONL 行号断裂或记录非法 | `RESOURCE_INTEGRITY_FAILED` |
| 操作中途取消 | `QUERY_CANCELLED` |
| Node 与浏览器输入相同 | 相同校验结论和错误码 |

HTTP 测试还必须覆盖 `206`、`Content-Range`、响应长度、CORS、取消和服务器错误地返回 `200` 的情况。

