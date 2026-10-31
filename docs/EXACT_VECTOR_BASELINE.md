# TypeScript 精确向量搜索基线

- 状态：首版已实现并通过自动化测试
- 目的：为 Rust、WASM 和 ANN Adapter 提供可复现的正确性参照，不作为最终高性能引擎

## 1. 数据链路

```text
ResourceReader.readRange
  → VectorBlockReader（Float32 LE 解码）
  → vectorDistance（cosine / l2 / ip）
  → exactVectorSearch（流式 Top-K）
  → IdMapReader（行号到业务 ID）
```

搜索一次只保留当前解码块和最多 `topK` 个结果。分块降低峰值内存，但不会降低精确扫描的总网络量与计算量。

## 2. 已实现语义

- Float32、小端序、row-major 显式解码，不依赖主机端序；
- 最后一块可少于请求块大小；
- 非有限数据值、响应长度错误和 ID 数量错误会被拒绝；
- Cosine 返回 `1 - similarity`；
- L2 返回欧氏距离；
- IP 返回负内积；
- 所有距离按升序排列；
- 相同距离按全局向量行号升序；
- 结果包含 `row`、业务 `id` 和 `distance`；
- 块之间检查 `AbortSignal`，取消后不继续读取后续块；
- 查询仅依赖 `ResourceReader` 和 `IdMapReader`，不依赖 HTTP、文件系统或具体 ANN 引擎。

## 3. 当前限制

- Top-K 已使用固定容量最大堆，候选维护复杂度为 `O(N log K)`；
- 已实现 JSONL + little-endian UInt64 偏移索引的批量随机访问 Reader；Builder 端索引生成和全量 ID 唯一性检查尚未实现；
- `getIdsByRows()` 要求行号唯一，排序后合并连续区间，并按调用方原始顺序返回；重复、负数和非安全整数行号会被拒绝；
- 精确搜索先完成距离扫描和最大堆筛选，只为最终 Top-K 候选读取业务 ID，不再为每个向量块读取整块 ID；
- 偏移文件声明长度严格等于 `count × 8`，单次连续批量默认限制为 256 行；
- 搜索按实际返回块长度推进，要求从第 0 行开始连续、无重叠、无乱序并完整覆盖集合；
- TypeScript 与 Rust 的跨语言黄金对照已接入：固定 fixture + 1e-6 容差，覆盖 6 个小型数据集，不覆盖 WASM；
- 尚未对真实大文件、浏览器内存或 HTTP Range 吞吐量进行基准测试；
- 精确扫描百万条 768 维向量仍需处理约 2.86 GiB 原始数据，分块不消除该成本；
- 当前实现是 SDK 内的正确性基线，尚未接入公开 `db.vector.search()` Adapter。

## 4. 测试覆盖

自动化测试覆盖小端 Float32 解码、块边界、短响应、NaN、Cosine/L2/IP、维度错误、零向量、Top-K、稳定排序、ID 映射数量、随机行分组、块覆盖和取消。最大堆使用固定种子生成 1000 个候选，并针对多个 K 值与完整暴力排序结果逐项比较。

跨语言一致性由 `npm run test:rust-golden`（校验提交的 fixture 仍等于 TypeScript 输出）和 `cargo test`（Rust 侧断言同一 fixture）共同保证。下一步应实现 Builder 端 ID Map/偏移文件生成器。

