# WeiSQL AI Vector Adapter 契约

- 状态：V1 设计基线草案
- 目标实现：Rust 精确搜索基线、后续 USearch Adapter；其他引擎可替换

## 1. 职责

Vector Adapter 屏蔽 USearch、DuckDB VSS 或未来向量引擎的内部差异。公共接口只表达向量名称、查询向量、Top-K、过滤条件、业务 ID 和统一距离。

`WeiSQLManifest`、`ResourceResolver`、错误码和公共向量类型由公共类型层定义。

## 2. 接口基线

```ts
export type VectorMetric = "cosine" | "l2" | "ip";

export interface VectorSearchRequest {
  vectorName: string;
  queryVector: Float32Array;
  topK: number;
  filter?: Readonly<Record<string, string | number | boolean | null>>;
  signal?: AbortSignal;
}

export interface VectorHit {
  id: string | number;
  distance: number;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface VectorAdapterCapabilities {
  engine: string;
  engineVersion?: string;
  metrics: readonly VectorMetric[];
  persistedIndex: boolean;
  metadataFiltering: boolean;
  exactSearch: boolean;
  cancellation: "native" | "best-effort" | "unsupported";
}

export interface VectorAdapterOpenContext {
  manifest: Readonly<WeiSQLManifest>;
  resourceResolver: ResourceResolver;
  signal?: AbortSignal;
}

export interface VectorAdapter {
  readonly capabilities: Readonly<VectorAdapterCapabilities>;

  open(context: VectorAdapterOpenContext): Promise<void>;
  search(request: VectorSearchRequest): Promise<readonly VectorHit[]>;
  close(): Promise<void>;
}
```

## 3. 统一距离语义

所有结果均按 `distance` 从小到大排列，越小越相似。

| 指标 | 公共 `distance` | 排序 |
| --- | --- | --- |
| Cosine | `1 - cosine_similarity` | 升序 |
| L2 | 欧氏距离（非平方距离） | 升序 |
| IP | `-inner_product` | 升序 |

Adapter 如果使用返回相似度、平方 L2 或其他方向的底层 API，必须在边界处转换。不能把引擎原始分数直接暴露为公共 `distance`。

## 4. 输入约束

- `topK` 必须是大于 0 的安全整数；
- 查询向量长度必须等于 Manifest 中的 `dimension`；
- 查询向量所有元素必须是有限数值；
- Cosine 查询拒绝零向量；
- `vectorName` 必须引用 Manifest 中存在的向量；
- Adapter 必须在大规模分配前应用维度、Top-K 和资源限制；
- 不得静默截断、填充或重新解释查询向量。

输入错误分别使用 `VECTOR_DIMENSION_MISMATCH` 或 `VECTOR_INVALID_VALUE`。

## 5. ID、排序与返回数量

- `VectorHit.id` 是稳定公共业务 ID，不是引擎内部整数位置；
- ID 映射不得依赖跨文件行号的隐含一致性；
- 相同距离按规范化业务 ID 稳定排序；V1 比较规则为：同类型数字按数值升序、字符串按 Unicode 码点升序，不同类型先数字后字符串；
- 返回结果不得超过 `topK`；候选不足时允许少于 `topK`；
- 返回距离必须为有限数值；
- 结果和 metadata 按公共契约视为只读。

浮点对照测试使用明确容差，不要求不同编译目标逐位一致。

## 6. 过滤语义

V1 过滤对象表示字段与标量值的精确相等条件，多个字段之间使用逻辑 AND。`null` 表示匹配空值，不表示忽略字段。

- `metadataFiltering: true` 仅在实现符合上述语义时声明；
- 不支持过滤时返回 `SQL_UNSUPPORTED` 或后续冻结的专用稳定错误，不能静默忽略；
- ANN-then-filter 可能返回少于 `topK`，必须在能力或诊断中说明；
- 精确回退只能由显式策略启用，不能因为索引不可用而无提示切换。

更复杂表达式、范围和全文条件不属于此 V1 过滤对象，需由后续搜索语义规范定义。

## 7. 索引与回退

- `persistedIndex` 表示 Adapter 能加载 Manifest 所描述的持久化索引，不表示任意引擎版本均兼容；
- 打开索引前必须验证能力、引擎版本策略和所请求的资源完整性；
- 索引缺失、损坏或不兼容不得静默忽略；
- 允许的精确搜索回退必须由打开选项或搜索策略显式启用并出现在诊断信息中；
- 原始向量数据是重建索引和精确基线的依据。

## 8. 生命周期与取消

- `open()` 成功后方可搜索；失败不得留下半初始化状态；
- `close()` 幂等，并释放 Native/WASM 内存、Worker 和索引句柄；
- 关闭后搜索返回 `DATABASE_CLOSED`；
- 查询前已取消返回 `QUERY_CANCELLED`；
- 中途取消行为必须符合 `cancellation` 能力声明，不能虚报底层计算已停止。

## 9. TypeScript 与 Rust 一致性

TypeScript SDK 和 Rust Core 共用错误语义、距离公式、维度规则、ID 规则及排序约定。跨语言固定测试至少覆盖：

- 空数据集、空向量与 Cosine 零向量；
- 查询与索引维度不一致；
- 相同距离候选的稳定排序；
- NaN 和 Infinity；
- `topK = 0`、负数和非整数；
- 字符串与数字业务 ID；
- 相同向量在 Rust、Node.js 与 WASM 中的距离结果。

距离比较必须声明绝对或相对浮点容差。

## 10. 一致性测试

每个 Vector Adapter 必须通过同一测试套件：

1. 三种指标的距离方向和数值转换；
2. 维度、有限值、零向量和 Top-K 校验；
3. 业务 ID 映射及相同距离稳定排序；
4. 过滤能力与不支持行为；
5. 索引缺失、损坏和显式回退策略；
6. 取消行为与能力声明一致；
7. `close()` 幂等，关闭后返回 `DATABASE_CLOSED`；
8. 精确实现结果一致；ANN 实现额外报告 Recall@K，不要求逐项完全相同。

当前 Rust crate 仅实现精确 Cosine 数值 ID 基线；尚未实现本契约中的 Adapter 生命周期、业务 ID、L2/IP、过滤和持久化索引。

