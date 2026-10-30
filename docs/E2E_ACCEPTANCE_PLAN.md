# WeiSQL AI V1 端到端验收计划

- 状态：实施计划
- 原则：先完成 3 条记录的可人工核对链路，再扩大到 10 万、50 万和 100 万向量

## 1. V1 已确定方向

| 设计项 | V1 决策 |
| --- | --- |
| 数据发布 | 多文件不可变数据包 |
| 结构化数据 | Parquet，由 SQL Adapter 读取 |
| 向量数据 | Float32、小端、行优先 |
| 向量 ID | 独立 `idMap` JSONL 文件 |
| 资源访问 | `ResourceReader` 抽象 |
| SQL | DuckDB / DuckDB-Wasm Adapter |
| 向量检索 | 独立 Vector Adapter，先精确基线后 ANN |
| 运行模式 | 只读 |
| 完整性 | 可配置 SHA-256 验证 |
| `.wsql` | 暂缓，待多文件访问与性能验证 |

## 2. 最小测试数据

| ID | 标题 | 向量 |
| --- | --- | --- |
| `doc-001` | DNA 结构 | `[1, 0]` |
| `doc-002` | RNA 转录 | `[0.9, 0.1]` |
| `doc-003` | 细胞代谢 | `[0, 1]` |

查询向量 `[1, 0]`，Cosine Distance 的预期顺序为：

1. `doc-001`
2. `doc-002`
3. `doc-003`

这是人工可核对的契约预期，不是未运行引擎的实测声明。实现测试必须使用明确浮点容差，并验证并列距离的稳定排序。

## 3. 数据包产物

Builder 生成：

```text
fixture/
├── manifest.json
├── data/documents.parquet
└── vectors/
    ├── embeddings.f32
    ├── id-map.jsonl
    └── id-map.offsets
```

Builder 必须写入实际字节数与 SHA-256，不得保留占位值，并验证：

- `idMap.count === data.count`；
- JSONL 行号从 0 连续递增；
- ID 唯一且存在于 `documents.id`；
- Float32 文件长度满足 `count × dimension × 4`；
- 所有资源路径安全且不重复。

## 4. 验收链路

1. Builder 生成 Parquet、Float32、ID Map 和 Manifest；
2. Runtime 执行 Manifest 结构及资源声明校验；
3. `ResourceReader` 校验文件大小并按策略验证摘要；
4. SQL Adapter 查询三条文档记录；
5. Vector Adapter 精确检索并产生向量行号/距离；
6. Runtime 通过 ID Map 转换为业务 ID；
7. 使用业务 ID 关联 SQL 元数据；
8. 断言 ID、距离、排序和返回字段；
9. 对 Node.js 与浏览器/WASM 结果进行容差内比较。

## 5. HTTP Range 验收

| 服务端行为 | 客户端要求 |
| --- | --- |
| `206` 且范围正确 | 接受并校验长度 |
| `200` 忽略 Range | 标记不支持，不得把整文件作为局部结果 |
| `416` | 返回可诊断的范围错误 |
| `Content-Range` 不匹配 | 拒绝 |
| 响应长度不匹配 | 拒绝 |
| CORS 阻止响应或所需头 | 返回可诊断网络错误 |

静态部署验收必须检查 `Content-Range`、`ETag` 等所需响应头是否通过 CORS 暴露。

## 6. 实施顺序

1. 将已接受的 `tableName`、`idMap` 决策原子迁移到正式 Schema、类型、校验器、样例和测试；
2. 完成 ID Map 语义校验；
3. ~~实现 `NodeFileResourceReader`；~~（首版已完成）
4. ~~实现 `HttpResourceReader` 与 Range 契约测试；~~（首版已完成）
5. 生成三条记录的真实 Parquet fixture；
6. ~~将 TypeScript 分块精确搜索基线接入 Indexed ID Map 与公开 Runtime；~~（已完成内存 fixture；真实 Builder fixture 待完成）
7. 完成包含真实 SQL Adapter 的 Node.js 端到端测试；
8. 接入 DuckDB-Wasm 并执行 Netlify/CDN 验收；
9. 从 100k 开始性能测试，再逐步扩大规模。

在完整链路通过前，不宣称 DuckDB、WASM、Netlify 或百万级向量能力已经完成验证。

