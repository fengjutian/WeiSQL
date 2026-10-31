# 跨环境兼容性对照（REQ-403）

- 命令：`npm run probe:parity`
- 覆盖：Manifest L1/L2 校验 + 精确向量检索 + 全文检索（BM25）+ RAG 证据组装 + `.wsql` 容器 + 错误码
- 运行时：Node.js（`NodeFileResourceReader` / `ContainerReader`）与 Chromium（`HttpResourceReader` / `ContainerReader`）

## 1. 为什么需要它

同一份 TypeScript 代码在 Node 与浏览器里可能因运行时差异产生不同结果：`fetch` 的接收者绑定、`Buffer` 与 `Uint8Array`、浮点格式化、错误对象形状。单元测试只在 Node 里跑，`probe:browser` 只验证浏览器能跑通——两者都不能证明**两端结果一致**。

这个命令把同一组输入分别在两端执行，逐字段比较：

- `ids` 与 `rows`：必须完全相等；
- 向量 `distances`：容差 `1e-6`；
- BM25 `scores`：容差 `1e-9`（同一 V8 的 `Math.log` 应逐位一致，容差只是防御）；
- `diagnostics.exact` / `backend`：必须相等；
- RAG 的 `ids` / `texts` / `ranks` / `truncated` / `usedCharacters` / `droppedHits`：必须相等；
- 容器的摘要计数、向量结果与全文结果：必须相等；
- 非法 Manifest：必须被拒绝且错误码相同。

## 2. 查询集与测试包

查询集定义在 `tools/browser-probe/parity-queries.mjs`，Node 与浏览器页面导入**同一文件**，避免两边各自维护而悄悄漂移。

| 查询 | 目的 |
| --- | --- |
| `self doc-001/002/003` | 每个向量作为查询，验证排序与自匹配距离为 0 |
| `diagonal` | 非轴对齐向量，覆盖一般余弦情形 |
| `opposite` | 反向向量，验证 `1 - similarity` 上界为 2 的排序 |
| `topK 1` | 截断行为 |
| `empty query` | 维度不匹配错误 |
| `zero query` | Cosine 零向量错误 |
| `text dna` / `text 细胞` / `text punctuation` | BM25 排序与 CJK 单字分词 |
| `text unknown` / `text empty` | 无命中与空查询返回空数组 |
| RAG `dna` | 字符预算内的证据组装与来源 |

提交的 fixture 不含派生索引，因此探针会**先构建再服务**：复制 fixture → 运行 `tools/build-text-index.mjs` → 运行 `weisql pack` 生成容器 → 把同一份目录与容器分别交给 Node 与 Chromium。两边读的是同一批字节，比较才有意义。

## 3. 当前结果

```
query             node                             browser                          match
self doc-001      doc-001,doc-002,doc-003          doc-001,doc-002,doc-003          PASS
...
text dna          doc-001                          doc-001                          PASS
text 细胞         doc-003                          doc-003                          PASS
text punctuation  doc-001                          doc-001                          PASS
text unknown      (none)                           (none)                           PASS
text empty        (none)                           (none)                           PASS

RESULT: 8 vector + 5 text queries, RAG evidence, 1 container and 6 manifest cases match
        (distance tolerance 0.000001, BM25 score tolerance 1e-9)
```

非法 Manifest 用例覆盖：错误 `format`、不支持的 `formatVersion`、路径穿越、未知列类型、向量字节数不匹配、重复资源路径——两端拒绝的错误码一致。

## 4. 覆盖不到的部分

- **SQL**：浏览器端没有可用引擎（DuckDB-Wasm 扩展下载受阻），因此只有 Node 侧有 SQL 证据；
- **混合过滤**：依赖 SQL，同上；
- **HTTP 细节**：两端都用同一份静态服务器，真实 CDN 的 CORS、缓存与 Range 行为未覆盖；
- **性能**：不比较耗时，只比较结果；
- **浮点边界**：仅用 2 维、3 条记录的数据包，不足以证明高维或大数集下的一致性；
- **大容器**：V1 容器整文件读入内存，探针只覆盖 3.6 KB 的包。

因此本对照可以支撑「SDK 的公开语义在 Node 与浏览器一致」这一有限结论，不能外推为「两个运行时具有相同能力」。
