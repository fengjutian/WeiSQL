# WeiSQL AI《向量搜索核心算法与一致性规范》V1.4

# 向量搜索核心算法与一致性规范

Vector Search Core · Correctness · Retrieval · Benchmark

文档版本

V1.4

目标环境

Node.js / Browser

首版算法

TypeScript 精确搜索

后续扩展

HNSW / WASM / Rust

状态说明：本文是正式工程设计规范草案，代码与性能指标仍需实际实现、编译和基准测试验证。

### 与当前仓库的差异

本文是**设计规范**，核心算法已实现并有自动化测试，但与本文描述存在出入：

| 本文的设计 | 当前仓库的实际状态 |
| --- | --- |
| Rust Core 作为向量计算主实现 | Rust 仅作 `crates/vector-benchmark` 对照基线；实际计算在 TypeScript 侧 |
| WASM 构建与 TypeScript/Rust 黄金数据对照 | 未实现；两侧各有单元测试，但没有跨实现的自动黄金数据比对 |
| 距离语义与 Top-K 稳定排序 | 已实现：Cosine / L2 / IP 统一为「越小越相似」，距离相同的行按行号升序稳定排序 |
| 向量读取方式 | `VectorBlockReader` 用 DataView **显式小端**解码 Float32，不依赖宿主字节序 |
| ANN 作为首版目标 | 首版是精确搜索；ANN 通过 `@weisql/usearch-adapter` 注入，且必须如实声明 `exactSearch: false` |

详细链路见 [`EXACT_VECTOR_BASELINE.md`](EXACT_VECTOR_BASELINE.md)。

## 一、设计目标与范围

WeiSQL AI 的向量搜索模块负责从静态数据包中读取向量，计算查询向量与数据向量之间的距离，返回 Top-K 结果，并通过 ID 映射与 SQL 表建立关联。

首版优先实现正确、可复现、内存可控的 TypeScript 精确搜索，然后才引入 ANN（近似最近邻）索引。

核心目标：

1. 支持余弦距离、欧氏距离和负内积三种度量方式。
2. 支持分块读取大型 Float32 向量文件。
3. 使用 Top-K 最大堆，避免对所有结果进行全量排序。
4. 支持非连续候选行的 ID 映射读取。
5. 对异常输入、数值误差、取消操作和数据损坏使用统一规则。
6. 提供可重复的基准测试，衡量搜索质量、延迟和内存。
7. 保证 Node.js 与浏览器实现遵循同一套搜索语义。

首版范围：

| 功能          | 首版要求  |
| ----------- | ----- |
| 精确向量搜索      | 必须    |
| 分块读取        | 必须    |
| 稳定 Top-K 排序 | 必须    |
| ID 映射       | 必须    |
| 取消查询        | 必须    |
| HNSW 近似搜索   | 后续阶段  |
| GPU 搜索      | 不纳入首版 |
| 向量写入和在线更新   | 不纳入首版 |
| 分布式向量索引     | 不纳入首版 |

## 二、整体架构

Vector Search API

query vector · topK · metric · signal

输入校验

维度、数值、参数

向量数据读取

ResourceReader / Float32

Exact Search Core

分块扫描 · 距离计算 · Top-K 最大堆

ID Map Reader

行号 → 文档 ID

Vector Result

距离、行号、ID

建议模块划分：

```
packages/vector/
├── src/
│   ├── types.ts
│   ├── validate-vector.ts
│   ├── distance.ts
│   ├── float32-reader.ts
│   ├── top-k-heap.ts
│   ├── exact-search.ts
│   ├── id-map-reader.ts
│   ├── group-rows.ts
│   └── index.ts
└── tests/
    ├── distance.test.ts
    ├── top-k-heap.test.ts
    ├── exact-search.test.ts
    ├── id-map-reader.test.ts
    └── consistency.test.ts
```

## 三、向量数据格式

### 3.1 二进制布局

首版统一采用：

- 数据类型：`Float32`
- 字节序：Little-endian
- 布局：Row-major
- 向量之间紧密排列
- 行号从 0 开始

例如，3 条、每条 4 维的向量：

embeddings.f32

v0[0]

v0[1]

v0[2]

v0[3]

v1[0]

v1[1]

v1[2]

v1[3]

v2[0]

v2[1]

v2[2]

v2[3]

每个元素占 4 字节；一条 D 维向量占 4D 字节。

第 \\(r\\) 条向量的字节偏移：

\\[ \operatorname{offset}(r)=r\times D\times4 \\]

总文件大小：

\\[ \operatorname{bytes}=N\times D\times4 \\]

其中：

- \\(N\\)：向量总条数。
- \\(D\\)：向量维度。

文件大小计算必须检查整数安全范围，不能假设任意 \\(N\\) 和 \\(D\\) 的乘积都能被 JavaScript 的 `number` 精确表示。

### 3.2 Float32 解码规范

不能依赖宿主机器字节序。应当显式使用 `DataView.getFloat32(offset, true)`，其中 `true` 表示小端序。

```
export function decodeFloat32LE(
  bytes: Uint8Array,
  expectedCount: number,
): Float32Array {
  if (
    !Number.isSafeInteger(expectedCount) ||
    expectedCount < 0 ||
    bytes.byteLength !== expectedCount * 4
  ) {
    throw new WeiSQLError({
      code: "RESOURCE_TRUNCATED",
      message: "Float32 byte length does not match expected element count.",
    });
  }

  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );

  const values = new Float32Array(expectedCount);

  for (let i = 0; i < expectedCount; i++) {
    const value = view.getFloat32(i * 4, true);

    if (!Number.isFinite(value)) {
      throw new WeiSQLError({
        code: "INVALID_VECTOR",
        message: "Vector data contains a non-finite value.",
        details: { index: i },
      });
    }

    values[i] = value;
  }

  return values;
}
```

以上代码依赖 `WeiSQLError` 已从 `@weisql/core` 导入；正式文件还应补充对应的 import。

实际读取时，应将字节数、行数和维度联合校验，防止一个不完整的块被当成有效向量。

## 四、距离函数与数值一致性

这是向量检索的核心契约。所有距离统一采用升序排列，数值越小表示越相近。

### 4.1 三种度量方式

设查询向量为 \\(q\\)，数据向量为 \\(x\\)，维度为 \\(D\\)。

#### 余弦距离

\\[ d\_{\cos}(q,x)=1-\frac{q\cdot x}{\\|q\\|\\|x\\|} \\]

- 取值理论上位于 \\([0,2]\\)。
- 完全同方向时为 0。
- 正交时为 1。
- 完全反方向时为 2。
- 任意一方为零向量时，余弦距离未定义，必须拒绝该输入。

#### 欧氏距离

\\[ d\_{L2}(q,x)=\sqrt{\sum\_{i=1}^{D}(q_i-x_i)^2} \\]

采用真正的欧氏距离，而不是平方欧氏距离。平方欧氏距离虽然具有相同的排序，但数值语义不同，不得混用。

#### 负内积距离

\\[ d\_{IP}(q,x)=-\sum\_{i=1}^{D}q_ix_i \\]

由于原始内积越大越相似，因此取负号后即可统一使用升序排序。

| Metric   | 返回的距离             | 排序方向 | 零向量 |
| -------- | ----------------- | ---- | --- |
| `cosine` | \\(1-\cos(q,x)\\) | 升序   | 拒绝  |
| `l2`     | 欧氏距离              | 升序   | 允许  |
| `ip`     | 负内积               | 升序   | 允许  |

### 4.2 浮点数一致性规则

不同 CPU、编译器、WASM 和原生库可能使用不同的运算顺序或 FMA（融合乘加），因此不能要求所有平台的浮点结果逐位相同。

建议区分两种一致性：

- 排序一致性： 对于没有近似并列的结果，排名应一致。
- 数值一致性： 距离差异应落在经过测试确定的容差范围内。

测试容差不能用于偷偷改变排序规则。对于完全相等的距离，使用稳定的次级排序键；对于仅仅非常接近的距离，不应默认将它们视为相等。

### 4.3 参考实现

```
import { WeiSQLError } from "@weisql/core";
import type { VectorMetric } from "@weisql/core";

export function vectorDistance(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  metric: VectorMetric,
): number {
  if (a.length === 0 || a.length !== b.length) {
    throw new WeiSQLError({
      code: "INVALID_VECTOR_DIMENSION",
      message: "Vectors must have the same non-zero dimension.",
      details: { a: a.length, b: b.length },
    });
  }

  let dot = 0;
  let normA2 = 0;
  let normB2 = 0;
  let squaredDistance = 0;

  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new WeiSQLError({
        code: "INVALID_VECTOR",
        message: "Vector contains a non-finite value.",
        details: { index: i },
      });
    }

    dot += x * y;
    normA2 += x * x;
    normB2 += y * y;

    const delta = x - y;
    squaredDistance += delta * delta;
  }

  let distance: number;

  switch (metric) {
    case "cosine": {
      if (normA2 === 0 || normB2 === 0) {
        throw new WeiSQLError({
          code: "INVALID_VECTOR",
          message: "Cosine distance is undefined for zero vectors.",
        });
      }

      const similarity = dot / Math.sqrt(normA2 * normB2);
      distance = 1 - Math.max(-1, Math.min(1, similarity));
      break;
    }

    case "l2":
      distance = Math.sqrt(squaredDistance);
      break;

    case "ip":
      distance = -dot;
      break;

    default: {
      const exhaustive: never = metric;
      throw new WeiSQLError({
        code: "INVALID_METRIC",
        message: `Unsupported vector metric: ${String(exhaustive)}`,
      });
    }
  }

  if (!Number.isFinite(distance)) {
    throw new WeiSQLError({
      code: "INVALID_VECTOR",
      message: "Vector distance is not finite.",
    });
  }

  return distance;
}
```

数值实现注意事项： 上面的函数适合作为第一版参考实现，但仍需加入极端数值测试。比如，有限的 Float32 元素平方后累加，仍可能让 JavaScript `number` 计算溢出。正式版应通过大值测试，决定采用缩放算法、补偿求和，还是对不支持的数值范围明确报错。

另外，余弦相似度计算中直接计算 `normA2 * normB2` 也可能溢出。不能仅靠最后的 `Number.isFinite` 证明数值算法在极端输入下可靠。

## 五、Top-K 最大堆

### 5.1 为什么使用最大堆

假设扫描 100 万条向量，最终只需要 10 条结果。

如果先保存全部距离再排序，需要存储大量候选结果，并进行 \\(O(N\log N)\\) 的排序。

最大堆只保存当前最好的 K 条结果：

\\[ O(N\log K) \\]

空间复杂度：

\\[ O(K) \\]

最大堆的根节点必须是当前 Top-K 中最差的结果。发现新候选比堆顶更好时，替换堆顶并重新调整堆。

### 5.2 稳定排序规则

统一按以下顺序比较结果：

1. `distance` 更小者优先。
2. `distance` 相同时，`row` 更小者优先。

定义：

```
export interface VectorCandidate {
  row: number;
  distance: number;
}

export function compareCandidates(
  a: VectorCandidate,
  b: VectorCandidate,
): number {
  if (a.distance < b.distance) return -1;
  if (a.distance > b.distance) return 1;

  return a.row - b.row;
}
```

由于 `row` 是非负安全整数，因此这里的差值比较可用于合法候选行号。生产代码仍应在候选入口验证行号和距离。

### 5.3 最大堆的关键不变量

对于当前堆：

- 堆中最多有 K 个候选。
- 堆顶是最差候选。
- 每个候选只保留一次。
- 最终结果通过稳定比较器排序后输出。
- 相同距离的候选不会因读取块的顺序不同而任意交换。

需要额外防止重复行进入堆。如果数据源契约保证每一行只扫描一次，堆本身不需要维护大型全局去重集合；但 ANN 引擎返回重复候选时，应由候选规范化层去重。

## 六、精确搜索执行流程

### 6.1 搜索过程

### 1

校验请求

检查维度、topK、metric、signal

### 2

读取向量块

按字节范围读取 Float32 数据

### 3

计算距离

逐行计算 query 与候选的距离

### 4

维护 Top-K

最大堆保留当前最优候选

### 5

读取 ID

批量获取候选行对应的业务 ID

### 6

输出结果

按 distance、row 稳定升序返回

### 6.2 分块读取

假设维度为 768，每次读取 1024 条向量：

\\[ 1024\times768\times4=3{,}145{,}728\text{ bytes} \\]

每块约 3 MiB。

这种块大小只是起始配置，不是性能结论。它影响：

- HTTP 请求次数。
- 单次内存占用。
- 缓存命中率。
- 取消查询的响应速度。
- 浏览器与 Node.js 的处理效率。

建议通过基准测试比较 128、256、512、1024 等不同块行数，不能预先断言哪一个最好。

### 6.3 搜索伪代码

```
exactSearch(query, source, topK, metric):
    validate query
    validate topK
    validate source dimension and count

    if source.count == 0 or topK == 0:
        return []

    heap = TopKMaxHeap(min(topK, source.count))

    for each vector block in source:
        check cancellation

        validate block range and shape

        for each row in block:
            distance = vectorDistance(query, row, metric)
            heap.offer({ row, distance })

    candidates = heap.toSortedArray()
    ids = idMap.getIdsByRows(candidates.rows)

    return candidates joined with ids
```

这里的 `source` 和 `idMap` 都应由明确的接口提供，不能让精确搜索核心依赖 DuckDB、USearch 等引擎的具体类型。

## 七、ID 映射与随机读取

向量文件中使用整数行号定位向量，而 SQL 表中使用业务 ID 关联文档。因此，需要独立的 ID 映射结构。

文件布局：

```
vectors/
├── embeddings.f32
├── id-map.jsonl
└── id-map.offsets
```

`id-map.jsonl`：

```
{"row":0,"id":"doc-001"}
{"row":1,"id":"doc-002"}
{"row":2,"id":"doc-003"}
```

`id-map.offsets` 使用 64 位小端无符号整数，存储每条 JSONL 记录的字节边界。

对于 N 条记录，偏移数组包含 N+1 个值：

\\[ \text{offsetBytes}=(N+1)\times8 \\]

必须满足：

- 第一个偏移为 0。
- 偏移单调不减。
- 最后一个偏移等于 JSONL 文件大小。
- 偏移值不超过安全读取范围。
- 每条记录能被正确解析。
- 记录中的 `row` 与其预期位置一致。
- `id` 符合格式要求。
- `uniqueIds: true` 时，构建器必须验证 ID 唯一性。

### 7.1 非连续行批量读取

例如，搜索结果行号是：

```
[3, 4, 5, 100, 101, 700]
```

应该合并成三个连续范围：

```
[3..5], [100..101], [700..700]
```

这样可以减少 HTTP 请求数量，但必须避免将跨度很大的稀疏行号合并成一个超大读取范围。

建议 `groupRows(rows)`：

1. 验证行号是非负安全整数。
2. 保留原始位置映射。
3. 排序并合并连续行。
4. 按配置限制每次读取的最大范围。
5. 读取后恢复调用方要求的原始顺序。

## 八、完整性与一致性要求

| 检查项目     | 要求                           |
| -------- | ---------------------------- |
| 向量维度     | 查询维度必须等于集合维度                 |
| 向量总数     | 必须与 Manifest 声明一致            |
| 向量文件大小   | 必须等于 `count × dimension × 4` |
| 数值有效性    | 禁止 NaN 和 Infinity            |
| 余弦输入     | 禁止零向量                        |
| Top-K 参数 | 非负安全整数；本设计允许 0 并返回空结果        |
| 行号       | 必须在 `[0, count)` 内           |
| 搜索结果     | 距离升序，行号用于稳定次级排序              |
| ID 映射    | 记录数量和行号必须一致                  |
| 资源版本     | 一次搜索不得混用不同数据版本               |
| 取消操作     | 取消后不再启动新的数据块读取               |
| 关闭操作     | 关闭后的新查询必须失败                  |

### 精确性定义

`exact: true` 表示搜索对声明的数据集合完成了全局精确 Top-K 搜索，而不只是计算距离时没有使用近似公式。

因此：

- 精确扫描所有符合条件的候选：`exact: true`。
- HNSW 只搜索有限候选：`exact: false`。
- ANN 找到候选后再精确计算候选距离：仍然是 `exact: false`。
- ANN 候选经过重排：也不能自动宣称全局精确。

这一规则对后续混合检索和 API 设计非常重要。

## 九、SQL 与向量过滤的一致性

WeiSQL AI 的混合检索可能需要先做 SQL 过滤，再执行向量搜索，也可能先做向量搜索再过滤。

两种路径的语义不同。

| 方案           | 执行方式                  | 能否保证过滤后的全局 Top-K |
| ------------ | --------------------- | ---------------- |
| Filter-first | 先确定所有符合条件的候选，再精确搜索    | 可以，前提是候选集完整      |
| Vector-first | 先搜索有限数量向量，再按 SQL 条件过滤 | 一般不可以            |
| ANN + rerank | ANN 取候选，再精确计算距离并重排    | 一般不可以            |
| ANN + 自适应扩候选 | 不断扩大 ANN 候选直到满足策略     | 仍不能普遍保证全局精确      |

举例：如果最近的 10 条向量全部不满足 SQL 条件，而第 11 条才满足，那么 `vector-first topK=10` 过滤后可能返回 0 条。

不能将这种结果解释成“没有匹配数据”。它只说明候选集合不足。

首版建议采用：

- 精确搜索：支持完整扫描。
- Filter-first：作为需要严格过滤语义时的正确性基准。
- Vector-first：明确标注候选限制和可能的召回损失。
- ANN：公开近似结果语义和可配置候选数。

过滤表达式应使用结构化字段和值参数，不允许直接把未经验证的用户字符串拼接成任意 SQL。

## 十、基准测试与验收

性能测试不能只测单次耗时，也不能只测最理想的缓存命中情况。

### 10.1 测试数据集

| 数据集规模     | 维度  | 原始 Float32 大小 |
| --------- | --- | ------------- |
| 100,000   | 768 | 307.2 MB      |
| 500,000   | 768 | 1.536 GB      |
| 1,000,000 | 768 | 3.072 GB      |

以上使用十进制 MB/GB；不包含 ID 映射、索引、缓存和临时内存。

测试还应覆盖：

- 随机生成的向量。
- 重复向量和相同距离候选。
- 极端大值与接近零的向量。
- 零向量及非有限值。
- 空数据集。
- 小于 K 条向量的数据集。
- SQL 过滤后候选很少的数据集。

### 10.2 质量指标

精确搜索本身应与独立的暴力排序基准比较，验证 Top-K 结果完全一致。

对于 ANN：

\\[ \operatorname{Recall\@K} = \frac{|\operatorname{ANN}\_K\cap\operatorname{Exact}\_K|}{K} \\]

当 \\(K=0\\) 时，该公式没有定义，应在评测中跳过该情况。

如果边界上存在大量相同距离的向量，单纯比较 ID 集合可能低估有效召回。测试规范应明确是否使用确定性次级排序，以及是否另外报告并列距离下的等价结果。

### 10.3 性能指标

必须记录：

- P50、P95 查询延迟。
- 冷缓存和热缓存延迟。
- 数据块读取次数。
- 实际读取字节数。
- 峰值内存。
- 初始化时间。
- ID 映射读取时间。
- ANN 的 Recall\@K。
- Node.js 与浏览器之间的结果一致性。

不要在没有固定硬件、数据分布和运行环境的情况下制定“百万条向量必须在 X 毫秒完成”的承诺。

### 10.4 必须通过的正确性测试

- 最大堆结果与暴力全量排序完全一致。
- 三种距离度量与独立参考实现一致。
- 相同距离时始终按行号稳定排序。
- 任意合法分块大小得到相同精确结果。
- 非连续 ID 查询恢复正确顺序。
- 空集合返回空结果。
- 取消后不继续启动新的分块读取。
- 数据文件截断时明确失败。
- 非法 ID 偏移不能越界读取。
- Node.js 与浏览器的搜索结果满足定义的一致性要求。
- ANN 返回值明确标记为近似搜索结果。

## 十一、开发阶段与交付顺序

阶段 A：正确性基线

实现距离函数、输入验证、最大堆、暴力排序对照测试。

阶段 B：分块读取

接入 ResourceReader，完成 Float32 解码、ID 映射和取消操作。

阶段 C：性能优化

调整块大小、缓存策略、Top-K 实现和内存分配。

阶段 D：ANN 适配器

在精确搜索基准稳定后，引入 HNSW 或 USearch，并测量 Recall\@K。

阶段 E：SQL 混合检索

统一 SQL 过滤、向量候选、ID 关联和结果排序语义。

## 十二、最终设计决策

本规范确定以下首版规则：

1. 使用 Float32 小端、行优先的二进制向量格式。
2. 以 TypeScript 精确搜索作为正确性基准。
3. 所有距离统一升序排序。
4. 使用最大堆维护 Top-K，按行号进行稳定次级排序。
5. ID 映射支持随机访问和非连续批量读取。
6. 精确搜索与近似搜索必须明确区分。
7. 数据读取采用分块机制，不默认把整个向量集合加载到内存。
8. SQL 过滤后的全局精确 Top-K 必须使用完整候选集或等价的精确执行方式。
9. 所有性能与跨平台一致性结论必须由自动化测试和基准测试支持。

下一份建议编写《WeiSQL AI Builder 数据构建与发布一致性规范 V1.5》，把 Parquet 生成、向量导入、ID 映射生成、索引构建、Manifest 生成、完整性校验和原子发布串成一条可重复执行的构建流水线。

