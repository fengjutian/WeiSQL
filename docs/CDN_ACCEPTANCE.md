# CDN 与 CORS 验收

- 状态：**工具已实现，真实部署未验收**
- 命令：`npm run probe:cdn -- --manifest <url> [--origin <站点 origin>] [--resource <路径>] [--json]`
- 适用：把 WeiSQL 数据包放在 CDN、Netlify、S3/CloudFront、R2 或任何静态托管上之后，部署应用之前。

## 1. 为什么需要单独验收

浏览器按需读取依赖 `fetch` + HTTP Range，而 Node 的 `fetch` **不执行 CORS**。本地服务器能跑通，不代表 CDN 会返回浏览器能读的响应头。以下任一项缺失，浏览器就会退化为整文件下载或直接失败：

| 响应头 | 作用 | 缺失后果 |
| --- | --- | --- |
| `Access-Control-Allow-Origin` | 允许站点跨域读取 | 浏览器直接拒绝 |
| `Access-Control-Expose-Headers: Content-Range, Accept-Ranges` | 让脚本读到分片边界 | `Content-Range` 读不到，Range 校验失败 |
| `Accept-Ranges: bytes` | 声明支持分片 | 客户端可能放弃 Range |
| `Content-Range: bytes 0-15/<size>` | 实际返回的分片 | 长度/边界校验失败 |
| `Content-Length: 16` | 返回体长度 | 短读检测失败 |
| `ETag` / `Cache-Control` | 缓存与重验证 | 性能下降；不是正确性前提 |

## 2. 探针做什么

`tools/cdn-probe.mjs` 读取 Manifest，选一个声明资源（默认第一个表；可用 `--resource` 指定），发一个 `Range: bytes=0-15` 请求，然后检查：

1. Manifest 返回 200，且带可用的 `Access-Control-Allow-Origin`；
2. 资源返回 **206**，不是 200；
3. `Content-Range` 精确等于 `bytes 0-15/<total>`；
4. `Content-Length` 为 16，实际响应体也是 16 字节；
5. `Accept-Ranges: bytes`；
6. `Content-Range` / `Accept-Ranges` 出现在 `Access-Control-Expose-Headers` 中；
7. `ETag`、`Cache-Control` 缺失时给警告，不算失败。

`--origin https://app.example.com` 用来固定站点来源；不传时只要求返回 `*` 或一个具体 origin（会提示无法精确比对）。`--json` 输出机器可读结果，适合 CI。

## 3. 典型通过示例

```bash
npm run probe:cdn -- \
  --manifest https://cdn.example.com/weisql/docs/manifest.json \
  --origin https://docs.example.com
```

输出全为 `PASS`，可能带 ETag/Cache-Control 的 `WARN`，退出码 0。任何 `FAIL` 退出码为 1，可直接接入发布流水线。

## 4. 常见失败与修复

| 现象 | 原因 | 修复 |
| --- | --- | --- |
| `Access-Control-Allow-Origin` missing | 托管未配置 CORS | 在 CDN/存储桶上允许站点 origin 或 `*` |
| `HTTP 206` fail，实际 200 | 源站忽略 Range，或 CDN 未开启分片回源 | 开启 Range/Partial Content；确认回源也支持 Range |
| `Content-Range` 不可读 | 只配了 ACAO，没暴露头 | 增加 `Access-Control-Expose-Headers: Content-Range, Accept-Ranges, ETag` |
| `Content-Length` 不是 16 | 代理压缩或改写了响应 | 对二进制资源关闭压缩；确认 206 分支直传 |
| ETag 每次变化 | 源站未给稳定 ETag | 为不可变版本配置稳定 ETag；版本目录本身不可变 |

## 5. 边界

- 这是**响应头级**验收，不替代真实浏览器。最终仍要跑一次 `npm run probe:browser` 的同类检查，或在目标浏览器手工确认 Network 面板里出现 `206`。
- 探针不验证 CDN 边缘缓存命中率、回源行为或多区域一致性；这些需要真实流量与监控。
- 数据包必须按不可变版本发布；`ETag`/`Cache-Control` 应围绕版本目录配置，不要原地覆盖同一 URL。
- `probe:cdn` 只读取 Manifest 声明的资源；未声明文件不会被检查，`weisql inspect` 仍应单独跑。

## 6. 验收记录模板

```json
{
  "manifest": "https://cdn.example.com/weisql/docs/manifest.json",
  "origin": "https://docs.example.com",
  "passed": 9,
  "failed": 0,
  "results": [
    { "name": "range: HTTP 206", "ok": true, "detail": "206 Partial Content" }
  ]
}
```

把 `--json` 输出与部署版本、时间、CDN 厂商一起存档；`docs/PROJECT_STATUS.md` 的“真实 CDN 未验收”只有在有这份记录后才能改成已验证。
