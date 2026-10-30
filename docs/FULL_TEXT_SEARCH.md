# 全文检索设计（REQ-306）

- 状态：**格式、校验、读取器、生成器与 Runtime 接入均已实现**
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
├── <name>.doclengths.bin   # UInt32 LE，每行 = 该文档的词项总数
├── <name>.ids.jsonl        # 行 → 业务 ID，形状与向量 ID Map 相同
└── <name>.ids.offsets      # UInt64 LE，ID 行起始偏移
```

ID Map 是必需的：全文索引只按行号打分，没有它就无法把结果回表成业务 ID。

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
  idMap: IdMapDescriptor;        // 行 → 业务 ID，count 必须等于 documentCount
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

词项定位用二分：`terms.offsets` 提供每个词项的起始字节，读一次该位置的词项即可比较大小。**排序与比较都使用 JavaScript 默认字符串比较（UTF-16 码元序）**，由生成器与读取器共享同一规则；不要混用 UTF-8 字节序，两者在星光面字符上不一致。定位一次 `O(log termCount)` 次 Range 读取。

每次查询还会完整读取 `docLengths`（每文档 4 字节）：BM25 需要每个候选的 `dl`。100 万文档时约 4 MB/查询，这是已记录的成本，不是隐藏开销。

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
3. ✅ 索引读取器（二分定位 + 倒排解码 + BM25 排序）
4. ✅ Runtime `text.search()` 与 `capabilities().textSearch`
5. ✅ 索引生成工具（`tools/build-text-index.mjs`，读 Parquet 文本列并回写 Manifest）

公开用法：

```ts
const db = await open({ manifest, resourceReader });
db.capabilities().textSearch;                      // 仅当 Manifest 声明了 textIndexes 且存在 Reader

const hits = await db.text.search("documents_text", "dna", { topK: 5 });
// [{ row: 0, id: "doc-001", score: 1.023, diagnostics: { backend: "text-bm25" } }]
```

`score` **越大越相关**，与 `vector.search` 的距离方向相反；两者不能直接比较大小，融合排序必须用 RRF（REQ-307）。

## 8. 端到端实测（fixture，3 篇文档）

```bash
node tools/build-text-index.mjs ./pkg --table documents --column title
weisql validate ./pkg      # resources: 9 checked, 9 hashes verified
```

```
dna      doc-001:1.023
细胞      doc-003:1.813
转录      doc-002:2.045
结构      doc-001:2.045
nothing  (none)
```

三件事由此得到验证：中文双字查询（`细胞`、`转录`）通过 CJK 单字倒排可以命中；稀有词得分高于常见词；不存在的词返回空而不是报错。这也说明「CJK 逐字」在当前数据规模上可用——但只有 3 篇文档，不能外推到长文本与大规模语料。
