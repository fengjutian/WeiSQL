# 跨环境兼容性对照（REQ-403）

- 命令：`npm run probe:parity`
- 覆盖：Manifest L1/L2 校验 + 精确向量检索 + 错误码
- 运行时：Node.js（`NodeFileResourceReader`）与 Chromium（`HttpResourceReader`）

## 1. 为什么需要它

同一份 TypeScript 代码在 Node 与浏览器里可能因运行时差异产生不同结果：`fetch` 的接收者绑定、`Buffer` 与 `Uint8Array`、浮点格式化、错误对象形状。单元测试只在 Node 里跑，`probe:browser` 只验证浏览器能跑通——两者都不能证明**两端结果一致**。

这个命令把同一组输入分别在两端执行，逐字段比较：

- `ids` 与 `rows`：必须完全相等；
- `distances`：容差 `1e-6`（明确声明，不要求逐位一致）；
- `diagnostics.exact` 与 `backend`：必须相等；
- 非法 Manifest：必须被拒绝且错误码相同。

## 2. 查询集

查询集定义在 `tools/browser-probe/parity-queries.mjs`，Node 与浏览器页面导入**同一文件**，避免两边各自维护而悄悄漂移。

| 查询 | 目的 |
| --- | --- |
| `self doc-001/002/003` | 每个向量作为查询，验证排序与自匹配距离为 0 |
| `diagonal` | 非轴对齐向量，覆盖一般余弦情形 |
| `opposite` | 反向向量，验证 `1 - similarity` 上界为 2 的排序 |
| `topK 1` | 截断行为 |
| `empty query` | 维度不匹配错误 |
| `zero query` | Cosine 零向量错误 |

## 3. 当前结果

```
query         node                             browser                          match
self doc-001  doc-001,doc-002,doc-003          doc-001,doc-002,doc-003          PASS
self doc-002  doc-002,doc-001,doc-003          doc-002,doc-001,doc-003          PASS
self doc-003  doc-003,doc-002,doc-001          doc-003,doc-002,doc-001          PASS
diagonal      doc-002,doc-001                  doc-002,doc-001                  PASS
opposite      doc-003,doc-002,doc-001          doc-003,doc-002,doc-001          PASS
topK 1        doc-001                          doc-001                          PASS
empty query   error:VECTOR_DIMENSION_MISMATCH  error:VECTOR_DIMENSION_MISMATCH  PASS
zero query    error:VECTOR_INVALID_VALUE       error:VECTOR_INVALID_VALUE       PASS

RESULT: 8 queries and 6 manifest cases match (distance tolerance 0.000001)
```

（`browser` 一列省略了绝对路径，实际输出会打印所用浏览器可执行文件。）

非法 Manifest 用例覆盖：错误 `format`、不支持的 `formatVersion`、路径穿越、未知列类型、向量字节数不匹配、重复资源路径——两端拒绝的错误码一致。

## 4. 覆盖不到的部分

- **SQL**：浏览器端没有可用引擎（DuckDB-Wasm 扩展下载受阻），因此只有 Node 侧有 SQL 证据；
- **混合检索**：依赖 SQL，同上；
- **HTTP 细节**：两端都用同一份静态服务器，真实 CDN 的 CORS、缓存与 Range 行为未覆盖；
- **性能**：不比较耗时，只比较结果；
- **浮点边界**：仅用 2 维、3 条记录的数据包，不足以证明高维或大数集下的一致性。

因此本对照可以支撑「SDK 的公开语义在 Node 与浏览器一致」这一有限结论，不能外推为「两个运行时具有相同能力」。
