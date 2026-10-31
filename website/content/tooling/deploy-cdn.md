---
title: 部署到 CDN
description: 把 WeiSQL 数据包发布到静态托管或 CDN，检查 Range、CORS、缓存与目录/单文件两种发布形态。
sidebar_position: 42
hero:
  kicker: "工具链 · 部署"
  title: "静态托管需要什么"
  lead: "Range、CORS、缓存与版本切换，决定浏览器端能否按需读取。"
  chips: ["206", "CORS", "cache"]
hide_title: true
examples: [browser]
---


WeiSQL 数据包是静态文件：没有数据库服务，也没有需要常驻的后端。部署工作主要是把目录或 `.wsql` 文件放到支持 HTTP Range 的静态托管上，并确认 CORS 暴露了客户端需要的响应头。读完本页你应当能选对发布形态，并用几条命令验证托管行为。

## 最小示例

```bash
# 1. 发布前校验，包含 Parquet 内容
npx weisql validate ./dist/demo --l4

# 2. 可选：打成单文件，减少上传对象数量
npx weisql pack ./dist/demo --output ./dist/demo.wsql

# 3. 验证 Range 与 CORS
curl -s -D - -o /dev/null \
  -H "Range: bytes=0-15" \
  https://cdn.example.com/datasets/demo/vectors/embeddings.f32
```

最后一条应返回 `206 Partial Content`，并带匹配的 `Content-Range: bytes 0-15/<总长度>`。如果返回 `200`，说明托管忽略了 Range，浏览器端会把它判为不支持。

目录模式的布局与包本身一致：

```text
https://cdn.example.com/datasets/demo/
├── manifest.json
├── data/documents.parquet
└── vectors/
    ├── embeddings.f32
    ├── id-map.jsonl
    └── id-map.offsets
```

## 发布形态

| 形态 | 读取方式 | 适合 | 代价 |
| --- | --- | --- | --- |
| 目录 | 每个资源按 Range 读取 | CDN 按需读取、频繁更新单个资源 | 上传对象多，漏传/路径大小写错误风险高 |
| `.wsql` 整包 | `ContainerReader` 一次读完整文件 | 单对象发布、包较小 | 首次使用要下载整包 |
| `.wsql` 流式 | `StreamingContainerReader` 只读头部，再按文件发 Range | 大容器、浏览器按需读取 | 托管必须支持 Range；压缩条目内 Range 需先取回整条并解压 |

目录模式通常是与 CDN 配合最好的形态；`.wsql` 的价值是把十几个文件合成一个对象，降低「漏传一个文件」的概率。压缩容器省体积，但会牺牲条目内的按需读取。

## 托管要求

| 要求 | 说明 |
| --- | --- |
| HTTP/HTTPS | 只允许 HTTP(S) 基准 URL；`file://` 不能替代真实验收 |
| Range | 必须返回 `206`，`Content-Range` 的起止与总长度必须匹配请求 |
| 长度 | 响应体长度必须等于请求范围；短读直接失败 |
| CORS | 允许页面来源，并暴露 `Content-Range`、`ETag` 等响应头 |
| 预检 | 跨域 `Range` 请求可能触发预检；需要允许 `Range` 请求头与 `GET`/`HEAD` |
| 路径 | 保持包内相对路径与大小写；重定向后仍要满足 origin 与包根约束 |
| 编码 | 不要启用会改变字节的动态压缩或转换；Range 偏移针对包内原始文件 |

CORS 响应头必须让 JavaScript 能读到 `Content-Range`；只设置 `Access-Control-Allow-Origin` 不够。可用下面的命令检查：

```bash
curl -sI -H "Origin: https://app.example.com" \
  https://cdn.example.com/datasets/demo/manifest.json
```

响应中应出现允许的 origin，以及包含 `Content-Range`、`ETag` 的 `Access-Control-Expose-Headers`。具体头名由托管商决定，验收标准是浏览器里的 `fetch` 能读到这些头并通过 Range 校验。

## 行为与边界

### 目录模式

`HttpResourceReader` 对每个资源发 Range 请求，`open()` 默认不预读；真正的 I/O 发生在第一次查询。精确向量检索每次查询都会完整扫过向量文件，分块只降低峰值内存，不减少总下载量。窄过滤可能只读取允许行，但这是运行时行为，不是托管层能保证的。

### `.wsql` 模式

- `ContainerReader` 需要整个文件在内存，适合已经下载的字节或小包；
- `StreamingContainerReader.open()` 只读 12 字节固定头与 JSON 头部，之后每次查询只请求需要的文件区间；
- 如果托管忽略 `Range` 并返回 `200` 整包，流式源会退化为整包切片——仍然可用，但失去按需读取的意义；
- 压缩容器的条目内 Range 需要先取回整条并解压再切片，这是压缩换体积的必然代价。

`.wsql` 还没有注册专用 MIME 类型；按通用二进制类型提供即可，客户端不依赖扩展名推断内容。

### 浏览器 SQL 的扩展

如果页面使用 [DuckDB-Wasm Adapter](/docs/adapters/duckdb-wasm)，`parquet` 扩展必须与页面同源托管。上游 `extensions.duckdb.org` 不返回 CORS 头，跨域下载会失败，`open()` 返回 `SQL_UNSUPPORTED`（`phase: "extension"`）。用 `npm run vendor:wasm-extension` 生成缓存，把 `/extensions/<version>/wasm_eh/` 一起部署，并设置 `extensionRepository`。

### 缓存与发布版本

- 发布目录最好带版本或内容标识，避免同一个 URL 在 CDN 与浏览器缓存之间混用新旧资源；
- `CachedResourceReader` 的键包含发布版本身份，`setPublicationVersion()` 换版本会清空应用级缓存，但清不掉 CDN 与浏览器的 HTTP 缓存；
- 更新时先上传新目录，再切换入口 URL；不要原地覆盖同名 Manifest 后假设所有边缘节点立即一致；
- 长缓存适合带内容哈希的文件名，`manifest.json` 应使用较短缓存或显式失效。

### 安全边界

静态数据包默认可以被任何人下载。不要把 API Key、访问令牌、私钥或私密数据放进包；签名只证明「Manifest 由对应私钥签署」，不提供加密或访问控制。SHA-256 用于检测内容是否与 Manifest 声明一致，不证明发布者身份。访问控制应由托管层负责。

### 部署后验收

```bash
npm run probe:cdn -- \
  --manifest https://cdn.example.com/weisql/docs/manifest.json \
  --origin https://docs.example.com
```

探针检查 `Access-Control-Allow-Origin`、`206`、`Content-Range`、`Content-Length`、`Accept-Ranges` 以及 `Access-Control-Expose-Headers`；完整清单与失败修复见 [CDN 与 CORS 验收](https://github.com/fengjutian/WeiSQL/blob/main/docs/CDN_ACCEPTANCE.md)。真实部署结果仍应附上 `--json` 输出与版本号。

### 未验证

- 真实 CDN 的 CORS、Range 与缓存行为尚未完成验收；仓库提供 `probe:cdn`，但没有真实部署结果；
- 多机、冷缓存与真实网络下的性能未测量；
- 浏览器内物化与 36.3 MB 首载已在本地 Chromium 测过，真实 CDN 网络下的数字未测；
- 压缩容器的流式读取只验证了语义，未做大容器实测。

因此本页给出的是托管要求与检查方法，不是「已在某家 CDN 验证」的结论。

## 常见错误

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `CORS_OR_RANGE_UNSUPPORTED` | 服务端忽略 Range 返回 `200` | 开启静态 Range 支持，或改用整包读取 |
| `INVALID_RANGE_RESPONSE` | `Content-Range` 缺失、起止不符或长度不对 | 检查托管/代理是否改写响应 |
| 浏览器报 CORS 错误 | 未允许来源，或未暴露 `Content-Range` | 配置 `Access-Control-Allow-Origin` 与 `Expose-Headers` |
| 资源 404 | 路径大小写不一致、漏传文件 | 用 `weisql inspect` 对照声明文件 |
| 流式 `.wsql` 仍然整包下载 | 托管不支持 Range，退化为整包切片 | 换支持 Range 的托管，或用目录模式 |
| 扩展加载失败 | 跨域访问 `extensions.duckdb.org` | 同源自托管并设置 `extensionRepository` |

## 延伸阅读

- [资源读取器](/docs/sdk/resource-readers)：HTTP Range、缓存与取消的客户端语义。
- [容器与完整性](/docs/sdk/containers)：`ContainerReader` 与 `StreamingContainerReader`。
- [DuckDB-Wasm Adapter](/docs/adapters/duckdb-wasm)：扩展同源托管的完整要求。
- [CLI](/docs/tooling/cli)：`validate`、`pack`、`inspect` 的用法。
- [兼容性](/docs/reference/compatibility)：运行时与托管能力矩阵。
- [容器格式](https://github.com/fengjutian/WeiSQL/blob/main/docs/WSQL_CONTAINER.md)。
- [Runtime 兼容性](https://github.com/fengjutian/WeiSQL/blob/main/docs/RUNTIME_COMPATIBILITY.md)。
