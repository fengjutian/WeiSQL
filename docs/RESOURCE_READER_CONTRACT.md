# WeiSQL AI ResourceReader 契约

- 状态：V1 设计基线；具体实现待完成
- 目标运行时：浏览器 HTTP(S)、Node.js 文件或 HTTP(S)

## 1. 目的

`ResourceReader` 为 Runtime 和 Adapter 提供统一资源访问边界。SQL/Vector Adapter 不直接拼接 URL、调用 Node.js 文件 API 或自行实现路径校验，从而让浏览器、Node.js 和未来 `.wsql` 容器共享上层逻辑。

Manifest 校验器负责验证逻辑路径；资源解析器负责确保逻辑路径仍位于数据包根范围内；Reader 负责读取与报告传输能力。

## 2. TypeScript 接口候选

```ts
export interface ResourceMetadata {
  size?: number;
  etag?: string;
  lastModified?: string;
  supportsRange?: boolean;
}

export interface ByteRange {
  /** Inclusive start offset. */
  start: number;
  /** Exclusive end offset. */
  end: number;
}

export interface ResourceReader {
  read(path: string, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
  readRange(path: string, range: ByteRange, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
  stat(path: string, options?: { signal?: AbortSignal }): Promise<ResourceMetadata>;
  close(): Promise<void>;
}
```

Range 使用左闭右开区间 `[start, end)`，长度为 `end - start`。两端必须是非负安全整数且 `end >= start`；`start === end` 返回空内容。

## 3. 安全与解析规则

- Reader 只接受通过 V1 校验的逻辑相对路径，并继续执行纵深防御；
- 浏览器实现使用受控数据包基准 URL，拒绝 origin 或包根逃逸；
- Node 文件实现解析后必须验证目标仍位于显式包根内；
- Adapter 不得自行处理 `..`、反斜杠、URL scheme 或重定向根逃逸；
- HTTP 跨 origin 重定向必须重新执行允许策略；
- 日志不得包含令牌、签名 URL 查询参数或资源内容。

## 4. Range 与流式读取

- `supportsRange` 只能根据实际响应或可靠探测声明；
- HTTP Range 必须验证 `206`、`Content-Range` 和返回长度；
- 服务端忽略 Range 并返回整文件时，不得误当作合法分段响应；
- 不支持 Range 时返回 `CORS_OR_RANGE_UNSUPPORTED`，除非调用方显式允许整文件回退；
- SHA-256 优先通过 `stream()` 增量处理，避免大型文件整体驻留内存。

## 5. 完整性职责

Reader 只提供字节。独立 Integrity 层负责比较声明大小、流式计算 SHA-256、比较摘要并返回 `RESOURCE_INTEGRITY_FAILED`。流式读取可以由实现内部或后续扩展接口提供。浏览器使用 Web Crypto 或经过评审的增量实现；Node.js 可使用 `node:crypto`，但 Node 专用依赖不得进入浏览器主包。

## 6. 生命周期与错误

- `close()` 幂等；关闭后读取返回稳定生命周期错误；
- 预取消操作返回 `QUERY_CANCELLED`；
- 404 映射为 `RESOURCE_NOT_FOUND`；
- Range/CORS 不兼容映射为 `CORS_OR_RANGE_UNSUPPORTED`；
- 大小或摘要不匹配映射为 `RESOURCE_INTEGRITY_FAILED`。

## 7. 契约测试

每个 Reader 至少测试完整读取、Range、零长度读取、非法参数、路径逃逸、404、超时、取消、错误 `Content-Range`、服务端忽略 Range、大小不匹配、流式 SHA-256，以及浏览器/Node 对固定资源返回相同字节。

当前 SDK 已定义接口和 ByteRange 校验，但尚未实现 `HttpResourceReader` 或 `NodeFileResourceReader`。
