# 全文检索设计（REQ-306）

- 状态：设计已定；**核心评分与分词已实现，格式与 Runtime 接入待做**
- 目标：在不可变静态数据包上做关键词检索，不引入服务端、不依赖 SQL 引擎

## 1. 范围

V1 只做**单列、单字段**的 BM25 检索：

- 一个文本索引绑定一个表的一个文本列；
- 查询是若干词项，按 BM25 打分，返回业务 ID 与分数；
- 不做短语、邻近、通配、前缀、同义词、拼写纠错；
- 不做跨字段加权（`title^3 body` 之类）；
- 不做停用词表（见 §5 的取舍）。

## 2. 数据包格式（提案）

```text
text-index/
├── <name>.terms.jsonl      # 按词项升序，一行一个词项及其倒排表
├── <name>.terms.offsets    # UInt64 LE，词项起始偏移，数量 = 词项数
└── <name>.doclengths.bin   # UInt32 LE，每行 = 该文档的词项总数
```

一行 `terms.jsonl` 的形状：

```json
{"term":"dna","df":2,"postings":[[0,1],[1,2]]}
```

`postings` 是 `[row, tf]` 对，`row` 升序。选择 JSONL 而不是二进制定点编码，理由与 ID Map 一致：**可人工核对、可用现有 L3 校验**。代价是体积——见 §6 的未决问题。

Manifest 增量（提案）：

```ts
textIndexes?: Array<{
  name: string;
  tableName: string;
  column: string;        // 必须声明为 string 或 json 类型
  idColumn: string;      // 必须是该表主键列
  documentCount: number; // 等于表行数
  termCount: number;
  averageDocumentLength: number;
  data: FileDescriptor;          // terms.jsonl
  termOffsets: FileDescriptor;   // u64-le，数量 = termCount
  docLengths: FileDescriptor;    // u32-le，数量 = documentCount
  k1?: number;  // 默认 1.2
  b?: number;   // 默认 0.75
}>;
```

校验规则（与现有 Manifest 规则同风格）：`tableName` 存在、`column` 存在且类型为 `string`/`json`、`idColumn` 在主键中、`termOffsets.bytes === termCount × 8`、`docLengths.bytes === documentCount × 4`、`documentCount > 0`、`k1 > 0`、`0 ≤ b ≤ 1`。

## 3. 查询流程

```text
query → tokenize → 逐词项在 terms.jsonl 中定位 → 读取倒排表
      → 累加 BM25 分数 → Top-K（分数降序，同分按 row 升序）
      → row → 业务 ID（复用现有 ID Map 读取器）
```

词项定位用二分：`terms.offsets` 提供每个词项的起始字节，读一次该位置的词项即可比较大小（词项行按字节序升序，与 JSON 字符串的 Unicode 码点序一致，前提是键名 `term` 固定在前——这一点由生成器保证）。定位一次 `O(log termCount)` 次 Range 读取；小包可直接整读 `terms.jsonl`。

## 4. 评分语义

BM25（`k1=1.2`、`b=0.75`，可在 Manifest 覆盖）：

```text
idf(t) = ln(1 + (N - df + 0.5) / (df + 0.5))
score  = Σ idf(t) · tf·(k1+1) / (tf + k1·(1 - b + b·dl/avgdl))
```

- **分数越大越相关**，与向量检索的「越小越好」相反。这是公开 API 里唯一的反向约定，必须在返回类型与文档中同时标注。
- 同分按 `row` 升序，保证跨运行稳定。
- `N`、`avgdl` 来自 Manifest 声明值；运行时不得重新统计全库（那会退化成全表扫描）。

## 5. 分词（V1 取舍）

`tokenize(text)` 的规则：

1. Unicode NFC 归一化，转小写；
2. 按「字母或数字」切分，其余字符视为分隔符；
3. 汉字、平假名、片假名、谚文**逐字符**作为独立词项（无分词器时唯一可预测的选择）；
4. 过滤长度小于 `minLength`（默认 1）的词项。`minLength > 1` 会丢弃全部 CJK 单字词项——这是预期行为：调用方要求更长词项时，单字检索已不在语义范围内。

明确不做：词干化、停用词、同义词、中文分词。后果要写进文档：中文按字匹配，召回高但精度低；英文 `running` 与 `ran` 不互相匹配。

## 6. 未决问题

1. **体积**：JSONL 倒排表比二进制定点编码大数倍。先按简单格式落地，等有真实数据再决定是否值得改格式——改格式属于破坏性变更。
2. **词项数上限**：是否需要 `maxTerms` 保护（恶意 Manifest 声明超大 `termCount`）。倾向由运行时预算统一限制。
3. **与向量融合**：REQ-307 需要混合排序。计划用 RRF（reciprocal rank fusion）而不是分数归一化，因为 BM25 分数与余弦距离不同量纲。这一步需要独立 ADR。
4. **增量更新**：静态包只支持整包重建，不做增量索引。

## 7. 实现顺序

1. ✅ 分词与 BM25 评分核心（可独立测试，无格式依赖）
2. ✅ Manifest `textIndexes` + 校验器 + Schema + L3 资源登记
3. ⬜ 索引读取器（二分定位 + 倒排解码）
4. Runtime `db.text.search()` 与能力声明
5. 索引生成工具（读取 Parquet 文本列，写三个文件并回写 Manifest）
