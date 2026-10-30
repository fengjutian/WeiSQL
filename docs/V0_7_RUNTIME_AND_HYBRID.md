# WeiSQL V0.7 Runtime API 与混合查询设计

- 状态：Runtime 精确向量最小闭环已实现；SQL、Hybrid 与 DuckDB 接入待完成
- 更新日期：2026-10-30

## 1. 模块协作边界

```text
应用（静态网站 / Node / RAG）
  → WeiSQL Runtime：open / sql / vector.search / capabilities / close
    → SQL Adapter（DuckDB / DuckDB-Wasm，待实现）
    → Vector 执行（TypeScript Exact 已接线；ANN 待实现）
      → ResourceReader（HTTP / Node / 注入实现）
        → Manifest + Parquet + Float32 + ID Map + 可选索引
```

SQL 与向量检索由 SDK 编排，不代表 DuckDB 已能优化整个混合计划。V1 必须把“结果严格等价”和“候选近似过滤”区分开。

## 2. 当前可运行 API

`open()` 支持两种互斥的 Manifest 来源：

```ts
await open({ manifestUrl, fetch, resourceReader });
await open({ manifest: parsedUnknown, resourceReader });
```

两种来源都必须经过同一运行时校验。直接传 `manifest` 适用于 Node、本地测试和上层已经安全读取 JSON 的场景；其类型保持为 `unknown`，不能绕过校验。`resourceReader` 被数据库实例拥有，`close()` 时一并关闭。

公开接口继续使用既有形状：

```ts
const rows = await db.sql("select * from documents where id = ?", [id]);
const hits = await db.vector.search("document_embeddings", query, { topK: 10 });
const capabilities = db.capabilities();
await db.close();
```

当前未配置 SQL Adapter 时，`sql()` 返回 `SQL_UNSUPPORTED`。不得返回模拟数据或静默执行另一种查询。

## 3. 精确向量执行流程

当 `open()` 收到 `resourceReader` 时，`vector.search()` 已形成以下闭环：

1. 校验集合名称、Top-K、维度、有限值和 Cosine 非零查询；
2. 从 Manifest 构造 `VectorBlockReader`；
3. 分块读取并解码 little-endian Float32；
4. 以统一距离语义扫描并用固定容量最大堆保留 Top-K；
5. 通过 `IndexedIdMapReader` 批量解析最终候选业务 ID；
6. 按距离、行号稳定返回 `row`、`id`、`distance` 和执行诊断。

诊断中的 `elapsedMs` 从输入校验完成后开始，包含向量 Range 读取、距离扫描、Top-K 和最终 ID 映射，不包含 `open()` 与 Manifest 获取时间。

当前过滤尚未实现；传入 `filter` 会明确返回 `SQL_UNSUPPORTED`，不会被忽略。

## 4. 能力探测

```ts
interface WeiSQLCapabilities {
  sql: boolean;
  vectorExactSearch: boolean;
  vectorAnnSearch: boolean;
  hybridSearch: boolean;
  resourceRange: boolean;
}
```

能力来自当前实例的实际接线。当前有 Reader 时精确搜索和 Range 为 `true`；SQL、ANN 与 Hybrid 为 `false`。后续 Adapter 初始化失败必须让 `open()` 失败或相应能力为 `false`，不能根据包名硬编码成功。

## 5. Hybrid V1 模式

计划先提供两个显式模式，不实现自动成本优化器：

| 模式 | 语义 | 结果保证 |
| --- | --- | --- |
| `vector-then-filter` | 向量取 Top-N，再用 SQL 参数化过滤 | 可能不足 K，不保证过滤全集的严格最近 K |
| `filter-then-exact` | SQL 得到完整允许 ID/行集合，再精确比较 | 保证过滤后集合的严格最近 K |

`vector-then-filter` 初始候选倍数、扩张步长和最大候选数必须显式配置并进入诊断。达到上限仍不足 K 时返回实际命中数，不补造结果。ANN 路径还必须说明不足可能来自近似漏召回。

`filter-then-exact` 需要 Vector 执行器支持允许行集合或位图；在该能力实现前不得通过先扫全量再丢弃结果冒充高效过滤。

Adaptive Hybrid 需要表统计、过滤选择率和实测成本模型，不属于 V0.7。

## 6. 结构化过滤安全

复杂 `FilterExpression` 尚未冻结。当前 V1 Adapter 契约只定义字段到标量的 AND 等值对象。后续扩展 `eq/ne/gt/gte/lt/lte/in/and/or` 时必须：

- 从 Manifest 白名单解析字段，标识符不能由值参数代替；
- 校验运算符与列类型兼容；
- 所有值通过 SQL Adapter 参数绑定；
- 限制表达式深度、节点数和 `in` 项数；
- 拒绝未知字段，不允许拼接任意 SQL 片段。

该表达式需要独立版本和测试后才能加入公开 API。

## 7. 最小端到端验收

当前自动化测试已经覆盖 `Manifest → 注入 ResourceReader → Float32 Range → Exact Top-K → Indexed ID Map → 公开 vector.search()`，并验证能力报告、过滤不支持、SQL 不支持和关闭传播。

完整产品链路仍缺少：

1. Builder 生成真实三记录 Parquet 与正确 SHA-256；
2. Node DuckDB Adapter 的只读参数化查询；
3. DuckDB-Wasm 浏览器对照；
4. SQL 与向量业务 ID 关联；
5. Hybrid 两种模式；
6. Netlify/CDN 的 CORS、Range、缓存和 WASM 部署验收。

这些项目通过前，不宣称 SQL、Hybrid、DuckDB-Wasm 或静态部署已经完成。

