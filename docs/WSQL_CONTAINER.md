# `.wsql` 单文件容器（V1）

- 状态：已实现（SDK 容器读写 + CLI `pack` / `validate`）
- 目标：把一个数据包打成单个文件，部署时只需上传一个对象

## 1. 为什么需要

一个数据包由 Manifest、Parquet、向量文件、ID Map、索引文件等十几个文件组成，且必须保持相对路径不变。部署到 CDN 或对象存储时，这既是操作负担，也是出错来源（漏传一个文件、路径大小写不一致）。容器把它们合为一个文件，`weisql validate` 仍然做同样的 L1/L2/L3 校验。

## 2. 布局

```text
"WSQLPKG1"              8 字节魔数（ASCII）
uint32 LE               头部 JSON 字节数
header JSON             UTF-8
file bytes...           按头部顺序紧邻排列
```

头部：

```json
{
  "formatVersion": "1.0.0",
  "files": [
    { "path": "manifest.json", "offset": 0, "bytes": 1908, "sha256": "…" }
  ]
}
```

- `offset` **相对于数据区起点**，必须从 0 开始连续排列；
- 每个条目的 `sha256` 覆盖该文件内容；
- 数据区末尾不允许有未被头部覆盖的字节（防截断/拼接）。

## 3. 明确的设计取舍

| 取舍 | 理由 |
| --- | --- |
| **不压缩** | 与 ID Map 用 JSONL 同源：可核对、可局部定位、可直接复用现有校验。压缩属于新格式版本，需要单独 ADR |
| **不加密** | 加密会改变「静态、只读、可公开校验」的模型；访问控制应由托管层负责 |
| **头部明文 JSON** | 便于人工检查与工具排查；体积相对数据区可忽略 |
| **两种读取方式** | `ContainerReader` 需要整个文件在内存（适合已下载的字节）；`StreamingContainerReader` 只读头部，之后按文件发 Range 请求（适合大容器与浏览器） |

## 4. 用法

### 打包与校验

```bash
weisql pack ./my-package --output ./my-package.wsql
weisql validate ./my-package.wsql
weisql unpack ./my-package.wsql --output ./extracted
```

`pack` 递归收集目录（按路径排序），要求存在 `manifest.json`。`validate` 检测目标是文件时自动走容器分支：先校验容器每个条目的摘要，再按 Manifest 做 L1/L2/L3。`unpack` **先校验全部摘要再写盘**，所以被篡改的容器不会留下半可信的目录。

### 运行时

```ts
import { ContainerReader, open } from "@weisql/sdk";

const bytes = new Uint8Array(await (await fetch("/my-package.wsql")).arrayBuffer());
const reader = new ContainerReader(bytes);
const manifest = JSON.parse(new TextDecoder().decode(await reader.read("manifest.json")));

const db = await open({ manifest, resourceReader: reader, verifyChecksums: "all" });
```

`ContainerReader` 实现标准 `ResourceReader`，所以 SQL / 向量 / 全文 / RAG 全部照常工作；它不依赖 `fetch`，也不依赖文件系统。

大容器不必整包下载——流式读取只需要一个 Range 源：

```ts
import { StreamingContainerReader, createHttpContainerSource, open } from "@weisql/sdk";

const reader = await StreamingContainerReader.open(
  createHttpContainerSource({ url: "https://cdn.example.com/dataset.wsql" }),
);
const manifest = JSON.parse(new TextDecoder().decode(await reader.read("manifest.json")));
const db = await open({ manifest, resourceReader: reader, verifyChecksums: "all" });
```

打开时只读 12 字节固定头 + JSON 头部；每次查询只请求需要的文件区间。若托管方忽略 `Range` 并返回 200 整包，源会退化为整包切片——仍可用，但失去按需读取的意义。

## 5. 校验与失败语义

| 情况 | 结果 |
| --- | --- |
| 魔数不符、头部长度越界、头部非 JSON | `RESOURCE_INTEGRITY_FAILED` |
| 条目 offset 不连续、路径重复、摘要格式错误 | `RESOURCE_INTEGRITY_FAILED` |
| 条目路径包含 `..`、绝对路径、反斜杠或空段 | `RESOURCE_INTEGRITY_FAILED`（解析阶段即拒绝） |
| 数据区有尾部多余字节 | `RESOURCE_INTEGRITY_FAILED` |
| 文件内容被篡改 | 容器摘要不符 → `RESOURCE_INTEGRITY_FAILED`（`validate` 报 issue） |
| 未知 `formatVersion` | `FORMAT_VERSION_UNSUPPORTED` |
| 容器内没有 Manifest 声明的资源 | 与目录模式一致的 `RESOURCE_NOT_FOUND` |

## 6. 尚未完成

1. 压缩（gzip/brotli）与对应版本协商。
2. 容器内的 Range 请求映射到 HTTP Range 的服务器端支持（当前由源直接发 Range，无需服务器配合）。
3. 与 `.wsql` 扩展名绑定的 MIME 类型注册。
