---
title: 单文件容器
description: 使用 .wsql 容器把数据包合成一个文件，选择整包内存读取或流式 Range 读取，并理解 gzip 条目、校验与失败语义。
sidebar_position: 26
hero:
  kicker: "SDK · 分发"
  title: "把数据包合成一个文件"
  lead: ".wsql 支持整包与流式读取；压缩条目内的 Range 需要先解压。"
  chips: [".wsql", "gzip", "stream"]
hide_title: true
examples: [node, browser]
---


本页讲 `.wsql` 单文件容器的布局、两个运行时读取器与 CLI 打包流程。读完后你能在“整包下载”和“只读头部 + 按文件 Range”之间做选择，并知道压缩条目对 Range 的代价。

## 最小示例

整包已在内存中：

```ts
import { ContainerReader, open } from "@weisql/sdk";

const response = await fetch("/datasets/demo.wsql");
const bytes = new Uint8Array(await response.arrayBuffer());

const reader = new ContainerReader(bytes);
const manifest = JSON.parse(new TextDecoder().decode(await reader.read("manifest.json")));

const db = await open({ manifest, resourceReader: reader, verifyChecksums: "all" });
```

流式读取：

```ts
import { StreamingContainerReader, createHttpContainerSource, open } from "@weisql/sdk";

const reader = await StreamingContainerReader.open(
  createHttpContainerSource({ url: "https://cdn.example.com/datasets/demo.wsql" }),
);
const manifest = JSON.parse(new TextDecoder().decode(await reader.read("manifest.json")));
const db = await open({ manifest, resourceReader: reader, verifyChecksums: "all" });
```

两个读取器都实现 `ResourceReader`，所以向量、全文、RAG 与 SQL 照常工作。

## 容器布局

```text
"WSQLPKG1"              8 字节魔数（ASCII）
uint32 LE               头部 JSON 字节数
header JSON             UTF-8
file bytes...           按头部顺序紧邻排列
```

头部形状：

```json
{
  "formatVersion": "1.1.0",
  "compression": "gzip",
  "files": [
    { "path": "manifest.json", "offset": 0, "bytes": 1908, "storedBytes": 741, "sha256": "..." }
  ]
}
```

| 字段 | 含义 |
| --- | --- |
| `offset` | 相对数据区起点，必须从 0 开始连续排列 |
| `bytes` | 解压后大小，也就是 Manifest 描述的值 |
| `storedBytes` | 写入后的大小；未压缩容器中等于 `bytes`，可省略 |
| `sha256` | 覆盖**解压后**内容，因此与压缩方式无关 |

数据区末尾不允许有未被头部覆盖的字节，用于防截断与拼接。

## 格式版本

| 版本 | 含义 |
| --- | --- |
| `1.0.0` | 未压缩；不得声明 `compression` |
| `1.1.0` | 每个条目独立 gzip；`compression: "gzip"` |

读取方接受两者；写入方按 `compress` 选择版本。压缩是逐条目的，同一容器里不能混用压缩与未压缩条目。当前只支持 gzip；brotli 需要新的版本号，尚未实现。

## ContainerReader

`new ContainerReader(bytes)` 需要完整容器字节，构造时解析并校验头部。

| 方法 | 说明 |
| --- | --- |
| `read(path)` | 返回整个文件 |
| `readRange(path, range)` | 返回 `[start, end)`；越界抛 `RESOURCE_INTEGRITY_FAILED` |
| `stat(path)` | 返回 `{ size, supportsRange: true }` |
| `verify(paths?)` | 逐条比对 sha256，返回不匹配列表；不传路径则校验全部 |
| `header` | 只读头部 |
| `close()` | 幂等；关闭后读取抛 `DATABASE_CLOSED` |

`verify()` 在解压失败时把 `actual` 记为 `"unreadable"`，而不是抛异常——它是报告损坏的工具。容器内不存在的路径抛 `INDEX_NOT_FOUND`。

## StreamingContainerReader

```ts
const reader = await StreamingContainerReader.open(source, { signal });
```

打开时只读 12 字节固定头与 JSON 头部；之后每次读取只请求所需文件的区间。`source` 需要实现 `size()` 与 `readRange(range, options?)`：

| 工厂/实现 | 用途 |
| --- | --- |
| `createBytesContainerSource(bytes)` | 内存字节源，测试与已下载场景 |
| `createHttpContainerSource({ url, fetch?, signal? })` | 静态托管上的容器；用一字节 Range 探测总长 |

HTTP 源的行为：

- 用 `Range: bytes=0-0` 与 `Content-Range` 得到总长度；
- 若服务端忽略 Range 返回 200，则退化为整包下载后切片——仍可用，但失去按需读取；
- 206 响应长度不等于请求长度抛 `RESOURCE_INTEGRITY_FAILED`；
- 200 回退时响应体短于请求区间同样抛 `RESOURCE_INTEGRITY_FAILED`；
- 不可达或非 OK 抛 `RESOURCE_NOT_FOUND`。

压缩容器同样支持流式读取，但**压缩条目内的 Range 必须先取回整条并解压再切片**。这是压缩换体积的必然代价；大向量文件上的实际开销未测量。

## 写入与 CLI

```ts
import { createContainer } from "@weisql/sdk";

const bytes = await createContainer(
  [
    { path: "manifest.json", bytes: manifestBytes },
    { path: "data/documents.parquet", bytes: parquetBytes },
  ],
  { compress: true },
);
```

`createContainer()` 校验路径安全性与重复项，按传入顺序写入头部；空文件列表或非法路径抛 `INVALID_ARGUMENT`。

命令行：

```bash
npx weisql pack ./my-package --output ./my-package.wsql
npx weisql pack ./my-package --compress --output ./my-package.wsql
npx weisql validate ./my-package.wsql
npx weisql unpack ./my-package.wsql --output ./extracted
```

`pack` 递归收集目录并按路径排序，要求存在 `manifest.json`；`--only-declared` 只打 Manifest 声明的资源并报告被跳过的文件。`validate` 检测目标是文件时自动走容器分支：先校验每个条目的摘要，再按 Manifest 做 L1/L2/L3。`unpack` 先校验全部摘要再写盘，被篡改的容器不会留下半可信目录。更多命令见 [CLI](/docs/tooling/cli)。

## 失败语义

| 情况 | 结果 |
| --- | --- |
| 魔数不符、固定头太短、头部长度越界、头部非 JSON | `RESOURCE_INTEGRITY_FAILED` |
| 条目 offset 不连续、路径重复、摘要格式错误 | `RESOURCE_INTEGRITY_FAILED` |
| 条目路径含 `..`、绝对路径、反斜杠或空段 | `RESOURCE_INTEGRITY_FAILED`（解析阶段拒绝） |
| 1.0.0 声明了 `compression` | `RESOURCE_INTEGRITY_FAILED` |
| 未知 `formatVersion` 或非 gzip 压缩 | `FORMAT_VERSION_UNSUPPORTED` |
| 数据区有尾部多余字节 | `RESOURCE_INTEGRITY_FAILED` |
| 条目内容被篡改 | `ContainerReader.verify()` 报告不匹配；L3 抛 `RESOURCE_INTEGRITY_FAILED` |
| 容器内没有 Manifest 声明的资源 | `INDEX_NOT_FOUND`（容器读取器） |
| 解压后大小不符 | `RESOURCE_INTEGRITY_FAILED` |

## 行为边界

- 容器不加密：静态包按设计可被下载，不要放入密钥或私密数据。
- 没有压缩算法协商，只有 gzip；没有与 `.wsql` 扩展名绑定的 MIME 注册。
- `ContainerReader` 要求整个文件在内存；大容器应使用流式读取器。
- 容器读取器不做 L3：完整性由 `open({ verifyChecksums })` 或 `verify()` 负责。
- 真实 CDN 上的 Range、CORS 与缓存行为未验证；流式方案的收益取决于托管方是否支持 Range。

## 延伸阅读

- [.wsql 容器格式](https://github.com/fengjutian/WeiSQL/blob/main/docs/WSQL_CONTAINER.md)
- [ResourceReader 契约](https://github.com/fengjutian/WeiSQL/blob/main/docs/RESOURCE_READER_CONTRACT.md)
