---
title: 资源读取器
description: 说明 ResourceReader 的半开区间契约、HTTP 与 Node 文件实现、缓存装饰器的并发与淘汰语义，以及自定义读取器的边界。
sidebar_position: 21
---

本页讲 Runtime 与 Adapter 共用的字节访问层：`ResourceReader` 的接口契约、内置的 HTTP 与 Node.js 文件实现，以及 `CachedResourceReader` 的缓存行为。读完后你能选对读取器，并在出现 200 响应、路径逃逸或短读时定位原因。

## 最小示例

浏览器里按需读取数据包：

```ts
import { HttpResourceReader } from "@weisql/sdk";

const reader = new HttpResourceReader({
  baseUrl: "https://cdn.example.com/datasets/demo/",
});

const header = await reader.readRange("vectors/embeddings.f32", { start: 0, end: 4096 });
console.log(header.byteLength); // 4096

const info = await reader.stat("vectors/embeddings.f32");
console.log(info.size, info.supportsRange);

await reader.close();
```

Node.js 端读取同一个目录：

```ts
import { NodeFileResourceReader } from "@weisql/sdk";

const reader = new NodeFileResourceReader({ rootDirectory: "./datasets/demo" });
const manifestBytes = await reader.read("manifest.json");
```

## 接口契约

```ts
interface ResourceReader {
  read(path: string, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
  readRange(path: string, range: ByteRange, options?: { signal?: AbortSignal }): Promise<Uint8Array>;
  stat(path: string, options?: { signal?: AbortSignal }): Promise<ResourceMetadata>;
  close(): Promise<void>;
}

interface ByteRange {
  start: number; // 包含
  end: number;   // 不包含
}
```

| 规则 | 要求 |
| --- | --- |
| 区间语义 | `[start, end)`，长度为 `end - start` |
| 范围合法性 | 两端为非负安全整数，且 `end >= start` |
| 空范围 | `start === end` 时返回空数组，不触发 I/O |
| 返回长度 | 必须严格等于请求长度；短读必须报错，不能补零或截断 |
| 路径 | 只接受 Manifest 校验过的规范相对路径；读取器再做纵深防御 |
| 生命周期 | `close()` 幂等；关闭后读取返回 `DATABASE_CLOSED` |
| 取消 | 预取消返回 `QUERY_CANCELLED` |

`stat()` 的 `ResourceMetadata` 含 `size`、`etag`、`lastModified`、`supportsRange`。`supportsRange` 只能根据真实响应声明，不能靠猜测；L3 的 `manifest` 模式依赖 `size`，缺失时抛 `RESOURCE_INTEGRITY_FAILED`。

## HttpResourceReader

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `baseUrl` | `string` | 无 | 数据包根 URL，必须是 http/https 且不含账号密码 |
| `fetch` | `typeof fetch` | 全局 `fetch` | 注入自定义实现，测试用 |
| `credentials` | `RequestCredentials` | `"same-origin"` | 透传给 fetch |
| `maxReadBytes` | `number` | 64 MiB | `read()` 接受的最大字节数 |
| `maxRangeBytes` | `number` | 64 MiB | 单次 `readRange()` 接受的最大字节数 |

`readRange()` 的校验顺序：

1. `start === end` 直接返回空数组；
2. 超过 `maxRangeBytes` 抛 `RESOURCE_INTEGRITY_FAILED`；
3. 发 `Range: bytes=start-(end-1)`；
4. 响应 `200` 抛 `CORS_OR_RANGE_UNSUPPORTED`（服务端忽略了 Range）；
5. 响应 `416` 抛 `INVALID_RANGE_RESPONSE`；
6. 非 `206` 时，404 抛 `RESOURCE_NOT_FOUND`，其他抛 `RESOURCE_READ_FAILED`；
7. `Content-Range` 必须存在、可解析，且起止与请求完全一致；
8. `Content-Range` 的总长度若存在，不得小于返回末字节；
9. `Content-Length` 若存在必须等于请求长度；
10. 响应体长度不符抛 `RESOURCE_INTEGRITY_FAILED`。

`read()` 用 `GET` 整文件读取，`Content-Length` 或实际长度超过 `maxReadBytes` 时报 `RESOURCE_INTEGRITY_FAILED`；空响应不算错误。

`stat()` 用 `HEAD`：`Content-Length` 给 `size`，`ETag`、`Last-Modified` 原样返回，`Accept-Ranges: bytes` 才置 `supportsRange: true`。`HEAD` 不可用时没有自动回退（当前未实现）。

重定向会重新做包根检查：最终 URL 的 origin 与 pathname 前缀都必须落在 `baseUrl` 内，否则抛 `PATH_INVALID`。

## NodeFileResourceReader

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `rootDirectory` | `string` | 无 | 数据包根目录，构造时解析为绝对路径 |
| `maxReadBytes` | `number` | 64 MiB | `read()` 接受的最大字节数；范围读取不受此限 |

安全检查不是字符串前缀比较，而是 `realpath()` 之后计算相对路径：

- 根目录与目标文件都先解析真实路径；
- 若相对路径为空、为 `..`、以 `../` 开头或是绝对路径，抛 `PATH_INVALID`；
- 符号链接指向包外时，`realpath` 已解析到包外，因此同样被拒绝；
- 目标不是普通文件抛 `RESOURCE_NOT_FOUND`；
- 文件不存在（`ENOENT`/`ENOTDIR`）映射 `RESOURCE_NOT_FOUND`，其他 I/O 错误映射 `RESOURCE_READ_FAILED`。

`readRange()` 精确读取请求区间：请求越界抛 `RESOURCE_INTEGRITY_FAILED`，读到文件末尾仍未填满同样抛错。`stat()` 返回 `size`、`lastModified`（ISO 字符串）与 `supportsRange: true`。

## CachedResourceReader

```ts
import { CachedResourceReader, HttpResourceReader } from "@weisql/sdk";

const cached = new CachedResourceReader({
  reader: new HttpResourceReader({ baseUrl: "/datasets/demo/" }),
  version: "demo-2026-01-01",
  maxCacheBytes: 32 * 1024 * 1024,
  maxEntryBytes: 1024 * 1024,
  maxConcurrentReads: 8,
});
```

| 选项 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `reader` | `ResourceReader` | 无 | 被装饰的读取器；缓存拥有并在 `close()` 时关闭它 |
| `maxCacheBytes` | `number` | 32 MiB | 按实际字节数计算的缓存上限 |
| `maxEntryBytes` | `number` | 1 MiB | 单条 Range 上限，超过则绕过缓存 |
| `maxConcurrentReads` | `number` | 8 | 并发底层读取上限，超出排队 |
| `version` | `string` | `"unversioned"`（独立使用时） | 发布版本身份，进入缓存键 |

行为要点：

- 只有 `readRange()` 进入缓存；`read()` 直接透传底层。
- 缓存键是「发布版本身份 + 路径 + start + end」，换版本必须让旧条目失效。
- 命中返回副本，调用方修改返回数组不会污染缓存。
- 长度超过 `maxEntryBytes` 的请求计入 `bypasses`，不写入缓存。
- 相同键的并发请求合并成一次底层读取，其余调用计入 `coalesced`。
- 单个调用方取消只让它自己收到 `QUERY_CANCELLED`；只有全部等待者都取消才中断底层请求。
- 失败、短读、被取消的读取都不进缓存；只有长度恰好等于请求长度的响应才写入。

`setPublicationVersion(version)` 换版本时清空所有条目，避免新旧发布混用：

```ts
cached.setPublicationVersion("demo-2026-02-01");
```

`stats()` 返回 `hits / misses / coalesced / bypasses / evictions / entries / cachedBytes / bytesRead / inflight`，适合放进基准报告。命中率与真实 CDN 表现未验证。

`open({ cache })` 会自动套上这一层，`version` 取 `manifest.datasetId`，不需要手动构造。

## 自定义读取器

实现四个方法即可接入 Runtime。最小要求：

- 用导出的 `validateByteRange(range)` 校验区间，或复刻同样的规则；
- 返回长度严格等于 `end - start`，短读抛 `RESOURCE_INTEGRITY_FAILED`；
- 对路径做包根 containment，拒绝 `..`、绝对路径、反斜杠；
- `close()` 幂等，关闭后所有读取抛 `DATABASE_CLOSED`；
- 取消映射为 `QUERY_CANCELLED`，网络错误映射为 `RESOURCE_READ_FAILED`。

容器读取器（`ContainerReader`、`StreamingContainerReader`）就是按这套接口实现的，语义见容器相关页面。

## 常见错误

| 错误码 | 原因 |
| --- | --- |
| `CORS_OR_RANGE_UNSUPPORTED` | 服务端忽略 Range 并返回 200；需要启用 Range 或改用整包容器 |
| `INVALID_RANGE_RESPONSE` | `Content-Range` 缺失、起止不符、416、或 `Content-Length` 不等于请求长度 |
| `RESOURCE_INTEGRITY_FAILED` | 短读、超出预算、文件在读取中变短、请求区间越过文件末尾 |
| `RESOURCE_NOT_FOUND` | HTTP 404、文件不存在、目标不是普通文件 |
| `RESOURCE_READ_FAILED` | 网络失败、非 404 的 HTTP 错误、非法 `Content-Length` |
| `PATH_INVALID` | 路径越出包根，或重定向逃出包根 |
| `QUERY_CANCELLED` | 读取前或读取中被取消 |
| `DATABASE_CLOSED` | Reader 已关闭 |

## 行为边界

- `CachedResourceReader` 不缓存整文件读取，也不做跨进程或持久化缓存。
- HTTP 读取器没有内置超时与重试；需要时由 `signal` 或外层策略控制。
- 真实 Netlify/CDN 的 CORS、Range 与缓存命中率未验证，自动化测试使用注入的 `fetch`。

## 延伸阅读

- [ResourceReader 契约](https://github.com/fengjutian/WeiSQL/blob/main/docs/RESOURCE_READER_CONTRACT.md)
- [资源完整性校验规范](https://github.com/fengjutian/WeiSQL/blob/main/docs/RESOURCE_INTEGRITY_SPEC.md)
