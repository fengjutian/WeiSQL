# 基准测量装置（REQ-404）

- 命令：`npm run bench`
- 脚本：`tools/bench/run.mjs`（测量）、`tools/bench/make-bench-package.py`（合成数据包）
- 状态：装置可用；下方数字是**单机一次测量**，不是性能承诺

## 1. 它测什么

| 阶段 | 说明 |
| --- | --- |
| 数据包生成 | pyarrow 写入 Parquet + Float32 + ID Map + Manifest，固定随机种子 |
| 完整性闸门 | 用 `@weisql/cli` 的 `validatePackage(mode: "all")` 全量校验；不通过直接退出，绝不测坏数据 |
| `open()` | `NodeFileResourceReader` + `open()` 的耗时 |
| 精确检索 | 固定种子生成的查询向量，逐条计时；报告 cold / min / p50 / p95 / max / avg |
| I/O | 包装 Reader，统计 Range 请求数与读取字节数（含每次查询的均摊） |
| 内存 | 20ms 采样 `process.memoryUsage().rss` 的峰值 |
| 环境 | CPU 型号、核数、内存、平台、Node 版本一并打印 |

查询向量由线性同余生成器在脚本内生成，种子固定为 `12345`，所以两次运行可比。

## 2. 记录结果（2026-10-30，单机）

环境：Intel Core Ultra 7 155H · 22 核 · 32 GiB · Windows 10.0.26200 x64 · Node v24.14.1

| 规模 | 向量字节 | 校验 | open | p50 | p95 | max | 峰值 RSS | 每查询读取 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5,000 × 32 | 640 KB | 36 ms | 0.4 ms | 9.8 ms | 13.8 ms | 13.8 ms | 56 MiB | 640 KB |
| 100,000 × 128 | 51.2 MB | 437 ms | 0.5 ms | 151.3 ms | 176.9 ms | 184.7 ms | 112 MiB | 51.2 MB |

可读出的事实：

- **精确检索每次查询都要完整扫一遍向量文件**：`rangeBytesPerQuery` 恰好等于 `vectorBytes`。分块读取降低的是峰值内存，不是总 I/O，这一点与文档一致。
- 100k × 128 的 20 次查询共 2,360 个 Range 请求，即每查询约 118 个块（10 万行 ÷ 1024 行/块）。
- 峰值内存 112 MiB，远小于向量文件 51.2 MB 的两倍——分块解码生效，而不是把文件整体载入。
- `open()` 不做预读，所以是亚毫秒级；真正的成本在第一次查询。

## 3. 明确不作数的部分

- **不是性能承诺**：单机、单次运行、热页缓存（校验已经读过全部文件）。没有多机复现，也没有冷缓存对照。
- **不含浏览器**：浏览器端没有端到端耗时数据；DuckDB-Wasm 仍受阻。
- **不含 ANN**：只有精确扫描基线，不能据此推断近似索引的延迟或召回。
- **不含百万级**：100 万 × 768 约 3 GB，本机未跑；`BENCHMARK_PROTOCOL_V1.md` 要求同时报告内存与下载量，单机也不足以代表 CDN 场景。
- **不含 SQL**：没有 DuckDB 参与，测的是 SDK 自身的扫描与解码。

## 4. 复现

```bash
npm run bench                                   # 100k x 128, 20 条查询
npm run bench -- --rows 20000 --dimension 64 --queries 10
npm run bench -- --package ./bench/pkg-5000x32  # 复用已生成的包
```

生成的包写入 `bench/`（已加入 `.gitignore`）。合成包依赖 Python + pyarrow；测量本身只需要 Node。

如果需要把这些数字写进对外材料，前提是：换一台机器复现、注明冷/热缓存、并补充浏览器侧数据。否则只能当作开发期基线。
