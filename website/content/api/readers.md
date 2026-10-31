---
title: Readers API
description: 速查 ResourceReader 契约、HTTP 与 Node 文件读取器的选项和失败语义、缓存读取器的统计字段，以及 .wsql 容器读取器与字节源的签名。
sidebar_position: 72
hero:
  kicker: "API · Readers"
  title: "字节访问的四个方法"
  lead: "HTTP、Node、缓存与容器的签名和失败语义。"
  chips: ["ByteRange", "LRU", "container"]
hide_title: true
examples: [node, browser]
---


本页是资源读取层的签名速查：`ResourceReader` 契约、内置读取器的选项与错误边界、缓存统计字段，以及 `.wsql` 容器读取器与字节源。使用场景见 [资源读取器](/docs/sdk/resource-readers) 与 [单文件容器](/docs/sdk/containers)。

## 导入

```ts
import {
  HttpResourceReader, NodeFileResourceReader, CachedResourceReader,
  ContainerReader, StreamingContainerReader, createBytesContainerSource,
  createContainer, createHttpContainerSource, validateByteRange,
} from "@weisql/sdk";
import type { ByteRange, CacheOptions, CacheStats, ContainerByteSource, ResourceMetadata, ResourceReader, ResourceReadOptions } from "@weisql/sdk";
```

## 接口定义

```ts
/** 半开区间：start 包含，end 不包含。 */
interface ByteRange { start: number; end: number }

interface ResourceMetadata {
  size?: number;
  etag?: string;
  lastModified?: string;
  supportsRange?: boolean;
}

interface ResourceReadOptions { signal?: AbortSignal }

interface ResourceReader {
  read(path: string, options?: ResourceReadOptions): Promise<Uint8Array>;
  readRange(path: string, range: ByteRange, options?: ResourceReadOptions): Promise<Uint8Array>;
  stat(path: string, options?: ResourceReadOptions): Promise<ResourceMetadata>;
  close(): Promise<void>;
}
```

`validateByteRange(range)` 校验区间：两端为非负安全整数且 `end >= start`，否则抛 `INVALID_ARGUMENT`。`readRange()` 必须返回长度严格等于 `end - start` 的数组，短读抛 `RESOURCE_INTEGRITY_FAILED`；空区间返回空数组且不触发 I/O。路径只接受规范相对路径，`close()` 幂等，关闭后读取抛 `DATABASE_CLOSED`，预取消抛 `QUERY_CANCELLED`。

## HttpResourceReader

```ts
interface HttpResourceReaderOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  credentials?: RequestCredentials;
  maxReadBytes?: number;
  maxRangeBytes?: number;
}
class HttpResourceReader implements ResourceReader { constructor(options: HttpResourceReaderOptions) }
```

| 选项 | 默认值 | 约束 |
| --- | --- | --- |
| `baseUrl` | 无 | 绝对 http/https URL，不能含账号密码；末尾斜杠自动补齐 |
| `fetch` | 全局 `fetch` | 绑定全局接收者；都没有时抛 `INVALID_ARGUMENT` |
| `credentials` | `"same-origin"` | 原样透传给每次请求 |
| `maxReadBytes` | 64 MiB | 正整数，否则 `INVALID_ARGUMENT` |
| `maxRangeBytes` | 64 MiB | 正整数，否则 `INVALID_ARGUMENT` |

```ts
const reader = new HttpResourceReader({ baseUrl: "https://cdn.example.com/datasets/demo/" });
const head = await reader.readRange("vectors/embeddings.f32", { start: 0, end: 16 });
await reader.close();
```

`readRange()` 的行为顺序：

1. 校验区间；空区间直接返回空数组。
2. 请求长度超过 `maxRangeBytes` 抛 `RESOURCE_INTEGRITY_FAILED`。
3. 发送 `Range: bytes=start-(end-1)`。
4. `200` 抛 `CORS_OR_RANGE_UNSUPPORTED`（服务端忽略 Range）；`416` 抛 `INVALID_RANGE_RESPONSE`。
5. 非 `206`：404 抛 `RESOURCE_NOT_FOUND`，其他状态抛 `RESOURCE_READ_FAILED`。
6. `Content-Range` 必须可解析、起止与请求一致、末字节小于总长；`Content-Length` 若存在必须等于请求长度；响应体长度不符抛 `RESOURCE_INTEGRITY_FAILED`。

`read()` 用 `GET` 读整文件，声明或实际长度超过 `maxReadBytes` 抛 `RESOURCE_INTEGRITY_FAILED`。`stat()` 用 `HEAD` 读取 `Content-Length`、`ETag`、`Last-Modified`；只有响应头 `Accept-Ranges: bytes` 才置 `supportsRange: true`，没有 HEAD 回退。

CORS 要求：跨域托管必须暴露 `Content-Range`、`Content-Length`、`ETag`、`Accept-Ranges`，并允许 `Range` 请求头，否则 Range 校验会失败或被浏览器拦截；真实 CDN 的配置尚未验证。路径与重定向都做包根检查：解析后的 URL 与最终响应 URL 的 origin、pathname 前缀都必须落在 `baseUrl` 内，否则抛 `PATH_INVALID`。网络错误映射 `RESOURCE_READ_FAILED`，取消映射 `QUERY_CANCELLED`；没有内置超时与重试。

## NodeFileResourceReader

```ts
interface NodeFileResourceReaderOptions {
  rootDirectory: string;
  maxReadBytes?: number; // read() 上限；范围读取不受此限
}
class NodeFileResourceReader implements ResourceReader { constructor(options: NodeFileResourceReaderOptions) }
```

| 选项 | 默认值 | 约束 |
| --- | --- | --- |
| `rootDirectory` | 无 | 非空字符串，构造时解析为绝对路径 |
| `maxReadBytes` | 64 MiB | 非负安全整数（允许 `0`） |

```ts
const reader = new NodeFileResourceReader({ rootDirectory: "./datasets/demo" });
const bytes = await reader.readRange("data/documents.parquet", { start: 0, end: 4 });
await reader.close();
```

containment 的实现是 `realpath` 之后比较相对路径，不是字符串前缀：

- 根目录与目标文件都先解析真实路径，符号链接指向包外会被解析出来并拒绝。
- 相对路径为空、为 `..`、以 `../` 开头或为绝对路径时抛 `PATH_INVALID`。
- 目标不是普通文件，或 `ENOENT` / `ENOTDIR`，抛 `RESOURCE_NOT_FOUND`；其他 I/O 错误抛 `RESOURCE_READ_FAILED`。
- 范围越过文件末尾、或读到 EOF 仍未填满，抛 `RESOURCE_INTEGRITY_FAILED`；`stat()` 返回 `size`、`lastModified`（ISO 字符串）与 `supportsRange: true`。

## CachedResourceReader

```ts
interface CachedResourceReaderOptions extends CacheOptions {
  reader: ResourceReader; // 被装饰的读取器，缓存拥有并在 close() 时关闭
}
class CachedResourceReader implements ResourceReader {
  constructor(options: CachedResourceReaderOptions);
  setPublicationVersion(version: string): void;
  stats(): CacheStats;
}
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `reader` | 无 | 必填；`close()` 会关闭它 |
| `maxCacheBytes` | 32 MiB | 缓存保留的总字节数 |
| `maxEntryBytes` | 1 MiB | 超过此长度的 Range 不进缓存，计为 `bypasses` |
| `maxConcurrentReads` | 8 | 并发底层读取上限，超出排队 |
| `version` | `"unversioned"` | 进入缓存键；`open({ cache })` 包装时默认为 `manifest.datasetId` |

```ts
const cached = new CachedResourceReader({ reader: new HttpResourceReader({ baseUrl: "/datasets/demo/" }), version: "demo-2026-01-01" });
await cached.readRange("vectors/embeddings.f32", { start: 0, end: 4096 });
```

`CacheStats` 字段：

| 字段 | 含义 |
| --- | --- |
| `hits` / `misses` | 命中缓存的请求数 / 需要读底层的请求数 |
| `coalesced` | 合并到进行中读取的请求数 |
| `bypasses` | 超过 `maxEntryBytes`、绕过缓存的请求数 |
| `evictions` / `entries` | 为守住字节预算淘汰的条目数 / 当前条目数 |
| `cachedBytes` / `bytesRead` | 当前缓存字节数 / 实际从底层读取的字节数 |
| `inflight` | 进行中的底层读取数 |

行为边界：

- 只有 `readRange()` 进缓存，`read()` 直接透传底层，也不参与合并。
- 缓存键由版本、路径、`start`、`end` 组成；命中返回副本，调用方修改不会污染缓存。
- 只有长度恰好等于请求长度的响应才写入；失败、短读、取消都不缓存；单条超过 `maxCacheBytes` 的响应可读但不驻留。
- 单个调用方取消只让它自己收到 `QUERY_CANCELLED`；全部等待者取消才中断底层请求。
- `setPublicationVersion()` 换版本会清空条目与字节计数；`stats()` 只存在于类上，不属于接口。

## ContainerReader

```ts
class ContainerReader implements ResourceReader {
  constructor(bytes: Uint8Array);
  readonly header: Readonly<ContainerHeader>;
  read(path: string, options?: ResourceReadOptions): Promise<Uint8Array>;
  readRange(path: string, range: ByteRange, options?: ResourceReadOptions): Promise<Uint8Array>;
  stat(path: string): Promise<ResourceMetadata>; // 不接受 options
  verify(paths?: readonly string[]): Promise<readonly { path: string; expected: string; actual: string }[]>;
  close(): Promise<void>;
}
```

```ts
const bytes = new Uint8Array(await (await fetch("/datasets/demo.wsql")).arrayBuffer());
const reader = new ContainerReader(bytes);
console.log(reader.header.files.map(entry => entry.path), await reader.verify());
```

构造时解析并校验头部，需要完整容器字节。`verify()` 逐条比对解压后内容的 SHA-256，返回不匹配列表；解压失败的条目记为 `actual: "unreadable"` 而不是抛异常。容器内不存在的路径抛 `INDEX_NOT_FOUND`，关闭后读取抛 `DATABASE_CLOSED`。每次 `readRange()` 都会先取出整个条目（必要时解压）再切片。

## StreamingContainerReader

```ts
class StreamingContainerReader implements ResourceReader {
  static open(source: ContainerByteSource, options?: ResourceReadOptions): Promise<StreamingContainerReader>;
  readonly header: ContainerHeader;
  read(path: string, options?: ResourceReadOptions): Promise<Uint8Array>;
  readRange(path: string, range: ByteRange, options?: ResourceReadOptions): Promise<Uint8Array>;
  stat(path: string): Promise<ResourceMetadata>;
  verify(paths?: readonly string[]): Promise<readonly { path: string; expected: string; actual: string }[]>;
  close(): Promise<void>;
}

interface ContainerByteSource {
  size(): Promise<number>;
  readRange(range: ByteRange, options?: ResourceReadOptions): Promise<Uint8Array>;
}
```

| 工厂 | 签名 | 说明 |
| --- | --- | --- |
| `createBytesContainerSource` | `(bytes: Uint8Array) => ContainerByteSource` | 内存字节源；越界读抛 `RESOURCE_INTEGRITY_FAILED` |
| `createHttpContainerSource` | `(options: { url: string; fetch?: typeof fetch; signal?: AbortSignal }) => ContainerByteSource` | 静态托管容器；用 `Range: bytes=0-0` 探测总长 |
| `createContainer` | `(files: readonly ContainerFile[], options?: { compress?: boolean }) => Promise<Uint8Array>` | `compress` 为 true 时写 gzip 的 1.1.0，否则 1.0.0 |

```ts
const source = createHttpContainerSource({ url: "https://cdn.example.com/demo.wsql" });
const reader = await StreamingContainerReader.open(source);
```

`open()` 只读 12 字节固定头与 JSON 头部；`size()` 若拿到 `Content-Range` 则缓存总长，若服务端忽略 Range 返回 200，则退化为整包下载后切片。HTTP 源的 `readRange()` 对 `206` 校验返回长度必须等于请求长度，200 回退时按响应体切片；两种情况长度不足都抛 `RESOURCE_INTEGRITY_FAILED`，响应非 OK 抛 `RESOURCE_NOT_FOUND`（网络层异常不包装，直接冒泡）。字节源本身不做包根 containment，条目路径的校验发生在头部解析阶段。

## 自定义 Reader 契约

实现四个方法即可接入 Runtime，必须满足：

1. 用 `validateByteRange()` 校验区间，或复刻同样的规则（非负安全整数、`end >= start`）。
2. `readRange()` 返回长度严格等于 `end - start`；短读抛 `RESOURCE_INTEGRITY_FAILED`。
3. 对 `path` 做包根 containment，拒绝 `..`、绝对路径、反斜杠与空段，失败抛 `PATH_INVALID`。
4. `close()` 幂等；关闭后所有读取抛 `DATABASE_CLOSED`。
5. 预取消与读取中取消都映射 `QUERY_CANCELLED`；网络或 I/O 错误映射 `RESOURCE_READ_FAILED`。
6. `stat()` 的 `supportsRange` 只根据真实能力声明，不能猜测。

注入 `open({ resourceReader })` 后，Reader 生命周期归 Runtime 所有，由 `db.close()` 关闭；需要缓存时优先用 `open({ cache })` 而不是手动嵌套。

## 延伸阅读

- [资源读取器](/docs/sdk/resource-readers)
- [单文件容器](/docs/sdk/containers)
- [ResourceReader 契约](https://github.com/fengjutian/WeiSQL/blob/main/docs/RESOURCE_READER_CONTRACT.md)
