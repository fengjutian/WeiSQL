# @weisql/sdk

WeiSQL AI 的只读 TypeScript SDK。当前版本提供：

- `validateManifest()`：Manifest V1 结构、路径和跨字段校验（L1/L2）。
- `open()`：接受 `manifestUrl` 或已解析的 `manifest`（二选一），返回生命周期受控的数据库对象。
- Runtime API：`sql()`、`vector.search()`、`capabilities()`、只读 `state` 和幂等 `close()`。
- 引擎无关的 `SqlAdapter` 注入契约（`open({ sqlAdapter })`）。
- 稳定的 `WeiSQLError` 错误码。
- `HttpResourceReader`：浏览器兼容的完整读取、严格 HTTP Range、元数据和取消支持。
- `NodeFileResourceReader`：Node.js 文件读取，`realpath` 包根 containment、符号链接逃逸防护和精确范围读取。
- `VectorBlockReader` 与 `exactVectorSearch()`：分块 Float32 解码及 Cosine/L2/IP 正确性基线。
- `IndexedIdMapReader` 与 `TopKMaxHeap`：JSONL/UInt64 偏移随机访问和 `O(N log K)` 候选维护。

注入 `resourceReader` 后，`vector.search()` 执行完整闭环（Range 读取 → Float32 解码
→ 距离扫描 → Top-K → Indexed ID Map → 业务 ID），诊断中标记 `exact: true`。
未注入 Reader 时返回 `INDEX_NOT_FOUND`，未注入 SQL Adapter 时 `sql()` 返回
`SQL_UNSUPPORTED`，不会返回模拟结果。仓库内没有 DuckDB 或任何真实 SQL 引擎实现。

HTTP Reader 与 Node 文件 Reader 已通过自动化测试，但尚未完成真实 Netlify/CDN 的
CORS、Range 和缓存验收，也尚未实现流式 SHA-256 校验；`verifyChecksums` 选项已在
类型中声明，L3（真实文件长度与 SHA-256）校验尚未接入 `open()`。

精确向量基线只用于语义验证和后续 Adapter 对照；Builder 端 ID 索引生成、ANN 索引和大规模性能验证尚未完成。

`IndexedIdMapReader.getIdsByRows()` 会拒绝重复或非法行号、合并连续候选行并恢复调用顺序；精确搜索验证向量块连续完整覆盖，并只在距离扫描完成后为最终 Top-K 解析业务 ID。测试使用 Node.js 内置测试运行器，可执行 `npm test` 或 `npm run test:watch`。

## 开发

在仓库根目录运行：

```sh
npm install
npm test
npm run typecheck
```

## Manifest 校验

```ts
import { validateManifest } from "@weisql/sdk";

const manifest = validateManifest(JSON.parse(source));
```

校验器除 JSON Schema 中的字段规则外，还检查：

- 路径穿越、绝对路径、反斜杠、URL scheme 和空路径段；
- 所有资源的规范化路径唯一性；
- `primaryKey` 是否引用已声明列；
- 向量集合的 `tableName`、`idColumn` 和主键引用；
- 数值是否为 JavaScript 安全整数；
- Manifest 主版本是否受支持。

## Runtime

```ts
import { open, NodeFileResourceReader } from "@weisql/sdk";

const db = await open({
  manifestUrl: "./demo/manifest.json",
  resourceReader: new NodeFileResourceReader({ rootDirectory: "./demo" }),
});

await db.vector.search("document_embeddings", new Float32Array([1, 0]), { topK: 10 });
await db.close();
```

`sql()` 需要注入实现了 `SqlAdapter` 的引擎适配器；本包只定义契约，不包含 DuckDB 或 DuckDB-Wasm 实现。
