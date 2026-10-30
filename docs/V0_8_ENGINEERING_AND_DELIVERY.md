# WeiSQL V0.8 工程分层与 V1 交付范围

- 状态：工程收敛规范
- 更新日期：2026-10-30

## 1. Monorepo 演进原则

目标模块边界包括 Manifest、Core、Runtime、Browser/Node Reader、SQL Adapter、Vector、Builder、测试 fixtures、Playground 和 Rust Core。但当前仓库暂时保留 `@weisql/sdk` 单包实现，在接口和发布关系尚未稳定时不进行纯目录式拆包。

只有满足以下条件时才建立独立 npm 包：

- 具有独立运行时依赖或发布节奏；
- 已有稳定的公共输入输出契约；
- 能运行独立单元测试和契约测试；
- 拆分不会产生循环依赖；
- Browser 构建能够证明不会打入 Node 专用模块。

计划依赖方向必须保持单向：

```text
manifest ─┐
core ─────┼→ runtime ← sql/vector adapters
          ├→ runtime-browser
          └→ runtime-node

builder → manifest/core（不得依赖 runtime-browser）
apps → runtime 与具体 Adapter 组合包
```

Rust 只迁移经基准确认的热点，不成为所有操作的必经路径。包管理器从 npm workspaces 迁移到 pnpm 需要独立变更和 CI 验证，不在文档写入时静默替换锁文件。

## 2. Runtime 生命周期

内部生命周期为：

```text
OPENING → READY → CLOSING → CLOSED
    └────→ FAILED（随后释放已创建资源）
```

公开 `open()` 是工厂函数，因此调用方只会获得 `READY` 实例；初始化失败不会返回半初始化对象。当前数据库公开只读 `state`：`OPENING | READY | FAILED | CLOSING | CLOSED`，但正常调用方主要观察到 `READY` 和 `CLOSED`。

规则：

- Manifest 必须先校验，再初始化 Adapter；
- SQL Adapter 需要统一 `ResourceReader`，不得自行逃逸包根；
- Adapter 初始化失败时关闭 Adapter 与 Reader；
- `close()` 立即转为 `CLOSING`，拒绝新查询，释放所有已注册资源后进入 `CLOSED`；
- `close()` 幂等；一个资源释放失败不能阻止其他资源的释放；
- 关闭后的 SQL 与向量调用返回 `DATABASE_CLOSED`；
- 不通过静默切换引擎掩盖初始化失败。

当前没有查询队列和强制中断所有在途操作的机制。加入并发上限、关闭超时或 WASM Worker 终止前，必须定义在途请求的所有权和测试语义。

## 3. SQL Adapter 接线

Runtime 已提供引擎无关的 `SqlAdapter` 注入契约：

```ts
interface SqlAdapter {
  readonly capabilities: SqlAdapterCapabilities;
  open(context: SqlAdapterOpenContext): Promise<void>;
  query<T>(statement: string, parameters?: readonly SQLValue[], options?: QueryOptions): Promise<readonly T[]>;
  close(): Promise<void>;
}
```

`db.sql()` 只负责生命周期、取消预检和委托，不解释 DuckDB 类型。没有 Adapter 时返回 `SQL_UNSUPPORTED`。`capabilities().sql` 只在当前实例成功初始化 SQL Adapter 后为 `true`。

DuckDB 与 DuckDB-Wasm 实现必须通过同一契约测试，至少覆盖参数绑定、只读限制、结果类型、大整数、取消、初始化失败清理和幂等关闭。SQL 文本过滤不能作为唯一安全边界；还要限制扩展、外部文件访问、DDL、写入、多语句和引擎配置。

底层 Reader 支持 Range 不代表 DuckDB-Wasm 一定按 Range 扫描 Parquet。真实浏览器验收必须测量请求数量、下载字节、重复缓存和峰值内存。

## 4. HybridExecutor 边界

Hybrid 不进入 Runtime 主类内部硬编码，而由独立执行器组合 SQL 与 Vector 能力。V1 计划支持：

```ts
type HybridStrategy = "exact-filter-first" | "vector-first";
```

### exact-filter-first

SQL 首先返回完整合格 ID/行集合，随后对全部合格向量执行精确距离比较。只有实际比较了完整过滤集合时，响应才能标记 `exact: true`。

该策略需要：安全的结构化过滤编译、业务 ID 到向量行的反向映射，以及精确搜索的允许行集合输入。三项能力尚未完成，因此当前不提供伪实现。

### vector-first

先生成有限向量候选，再由参数化 SQL 过滤和读取文档。即使第一步使用精确距离，有限候选仍不能保证过滤全集上的全局 Top-K，因此响应 `exact` 必须为 `false`。候选不足时返回实际数量，并报告候选上限和过滤后数量。

Adaptive 策略、BM25 与 RRF 不属于 V1 基础闭环。

## 5. ID 关联规则

当前 Manifest 和 ID Map 允许 `string | number` 业务 ID；不能在 V0.8 文档中静默改成仅字符串，否则会破坏已冻结格式和现有测试。Builder 与 SQL Adapter 必须保持 ID 类型一致，禁止 JavaScript 隐式字符串化关联。

若未来决定 V2 仅支持字符串 ID，需要版本升级、Schema 变更和迁移工具。V1 Builder 必须验证：

- 每个向量行恰好对应一个 ID；
- `uniqueIds: true` 时 ID 在类型和值层面唯一；
- ID 存在于目标表主键且类型匹配；
- 行号连续并位于合法范围；
- 主键非空且唯一。

## 6. V1 功能冻结

| 能力 | V1 范围 | 当前状态 |
| --- | --- | --- |
| Manifest V1 与路径校验 | 必须 | 已实现 L1/L2 |
| Node 与 HTTP Reader | 必须 | 首版已实现 |
| 精确向量检索与 ID Map | 必须 | 已接入公开 Runtime |
| 只读 SQL | 必须 | Node.js DuckDB 首版已完成；DuckDB-Wasm 待实现 |
| 基础 Hybrid 两策略 | 必须 | `exact-filter-first` 已完成（含反向 ID 映射）；`vector-first` 待实现 |
| Range/LRU 缓存 | 基础实现 | Range 已完成，LRU 待完成 |
| Builder 与真实 fixture | 必须 | 首版已完成：`buildPackage()` + `examples/fixture`；CSV/JSON 推断未实现 |
| Playground/静态部署 | 必须 | 待完成 |
| USearch ANN | 实验或后置 | 未实现 |
| Rust/WASM 全面迁移 | 后置 | 不计划全面迁移 |
| 写入、事务、多用户同步 | 不纳入 | 明确排除 |
| 单文件 `.wsql` | 后置 | 布局未冻结 |

## 7. 下一交付里程碑

最短关键路径为：

1. ~~Builder 生成三记录真实 Parquet、Float32、JSONL、偏移和正式摘要~~（首版已完成，见 `examples/fixture`）；
2. ~~实现 Node DuckDB 只读 Adapter 及契约测试~~（首版已完成，见 `packages/duckdb-adapter`）；
3. 完成 Manifest → SQL → Exact Vector → ID 关联的 Node 端到端测试；
4. 实现结构化等值过滤与 `vector-first`；
5. 增加业务 ID 到向量行的反向映射，再实现 `exact-filter-first`；
6. 接入 DuckDB-Wasm 并运行浏览器/Netlify 验收；
7. 最后实现有界 LRU 与 Playground 诊断界面。

在第 3 步完成前，不宣称真实 SQL 闭环已完成；在第 6 步完成前，不宣称浏览器静态数据库已通过验收。

