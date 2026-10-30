# WeiSQL AI Runtime 执行语义与一致性规范 V1.1

## 一、冻结三个关键接口决策

决策 1：大结果集采用分页与异步迭代

小结果集可以直接返回数组；大结果集应支持游标或异步迭代，避免将所有结果一次性放入内存。

决策 2：close() 进入关闭流程并取消未完成查询

关闭后拒绝新操作；运行中的操作尽可能取消，等待资源清理完成。底层引擎不能及时取消时，必须定义等待和超时行为。

决策 3：一次打开绑定不可变的数据集版本

同一次 Runtime 实例不能混读不同版本的数据文件。发布使用版本化目录，资源引用由已验证的 Manifest 解析。

这三项是建议冻结的产品规范，正式编码时还应通过引擎行为和浏览器实测确认具体限制。

## 二、查询结果与内存控制

### 2.1 为什么不能所有查询都返回数组？

例如查询返回 100 万行数据，每行包含多个字符串字段，即使底层 Parquet 文件较小，解码成 JavaScript 对象后也可能占用大量内存。

因此，WeiSQL AI 需要区分两类查询接口：

| 接口                | 使用场景      | 行为               |
| ----------------- | --------- | ---------------- |
| `sql()`           | 小结果集      | 返回 `QueryResult` |
| `sqlStream()`     | 大结果集      | 分批异步迭代           |
| `queryPage()`     | 页面表格、管理界面 | 按页读取             |
| `vector.search()` | Top-K 召回  | 返回有限数量的命中结果      |

### 2.2 建议的 TypeScript 契约

```
export interface QueryOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxRows?: number;
}

export interface QueryColumn {
  name: string;
  type: string;
  nullable?: boolean;
}

export interface QueryResult<T> {
  columns: QueryColumn[];
  rows: T[];
  rowCount: number;
  executionTimeMs: number;
}

export interface QueryPageOptions {
  limit: number;
  offset?: number;
  signal?: AbortSignal;
}

export interface QueryStreamOptions {
  batchSize?: number;
  signal?: AbortSignal;
}

export interface QueryStream<T> extends AsyncIterable<T> {
  readonly columns: readonly QueryColumn[];
  close(): Promise<void>;
}
```

建议公开 API：

```
interface WeiSQLDatabase {
  sql<T extends Record<string, unknown>>(
    query: string,
    params?: readonly unknown[],
    options?: QueryOptions,
  ): Promise<QueryResult<T>>;

  queryPage<T extends Record<string, unknown>>(
    query: string,
    params: readonly unknown[],
    options: QueryPageOptions,
  ): Promise<QueryResult<T>>;

  sqlStream<T extends Record<string, unknown>>(
    query: string,
    params?: readonly unknown[],
    options?: QueryStreamOptions,
  ): Promise<QueryStream<T>>;
}
```

必须明确的实现限制：

- `sql()` 应有默认的结果行数上限或其他可验证的资源限制。
- `queryPage()` 不能通过字符串拼接不可信的 `LIMIT`、`OFFSET` 参数。
- `OFFSET` 分页不保证高效，也不保证数据变化时的跨页稳定性；静态只读数据包可以利用不可变版本降低这一风险。
- `sqlStream()` 的提前退出、迭代失败和取消都必须释放底层游标。
- 如果底层引擎不支持真正的流式读取，适配器必须明确说明其缓存行为，不能仅仅因为 API 返回异步迭代器就宣称内存恒定。

## 三、关闭与并发查询语义

### 3.1 Runtime 生命周期规则

READY

可以接受新查询

close() 被调用

CLOSING

拒绝新请求、通知在途任务取消、清理资源

CLOSED

清理完成，后续调用统一报错

### 3.2 具体规则

1. 第一次 `close()` 开始后，实例立即进入 `CLOSING`，不再接受新查询。
2. 同时调用多次 `close()` 时，所有调用共享同一个关闭流程。
3. 已经运行的查询收到内部取消信号；支持取消的引擎应尽快终止。
4. 不能立即取消的任务必须被追踪，避免在底层资源已经释放后继续访问资源。
5. 关闭流程必须释放游标、引擎句柄、文件句柄和缓存资源。
6. 关闭失败不得被伪装成完全成功，应保留可诊断的错误信息。
7. `CLOSED` 状态不能恢复为 `READY`，需要重新调用 `open()`。

### 3.3 错误分类

| 场景             | 建议错误                                  |
| -------------- | ------------------------------------- |
| 用户主动取消查询       | `CANCELLED`                           |
| 关闭后提交新查询       | `RESOURCE_CLOSED`                     |
| 打开过程中取消        | `CANCELLED`                           |
| 数据文件读取期间发生网络故障 | `NETWORK_ERROR`                       |
| 资源返回字节数不足      | `RESOURCE_TRUNCATED`                  |
| 引擎初始化失败        | `ENGINE_UNAVAILABLE` 或 `ENGINE_ERROR` |

不要把关闭操作触发的内部取消和用户主动取消混为一谈。若应用需要区分原因，可以在错误详情中记录取消来源，但公共错误码应保持稳定。

## 四、数据版本一致性

这是 WeiSQL AI 作为静态网站数据层时最重要的规则之一。

### 4.1 推荐的数据包发布结构

```
public/
└── datasets/
    ├── releases/
    │   ├── 2026-10-01/
    │   │   ├── manifest.json
    │   │   ├── data/
    │   │   └── vectors/
    │   └── 2026-10-15/
    │       ├── manifest.json
    │       ├── data/
    │       └── vectors/
    └── current.json
```

建议将 `current.json` 作为可选的发布入口，内容只负责指向某个不可变版本。运行时解析一次版本后，后续所有资源读取都使用该版本的固定根路径。

### 4.2 一致性规则

- `manifest.json` 一旦发布，不应原地修改。
- 数据文件与 Manifest 必须作为同一个版本发布。
- 每个资源路径都必须相对于该版本根目录解析。
- 如果当前版本指针变化，已打开的 Runtime 不自动切换版本。
- 缓存键至少包含数据集标识、版本、资源路径和字节范围。
- 不能仅依赖 ETag 来证明数据完整性；ETag 主要用于缓存验证，其语义取决于服务器。
- 如果版本中的资源被意外覆盖，应通过内容哈希检查发现不一致。
- 跨版本更新应创建新版本目录，而不是在旧目录中逐个覆盖文件。

### 4.3 Manifest 的建议补充

```
export interface DatasetInfo {
  id: string;
  formatVersion: string;
  datasetVersion: string;
  manifestSha256?: string;
}
```

`manifestSha256` 可以作为可选的外部完整性锚点，但必须明确哈希的计算规则，例如是否排除该字段本身，避免出现自引用定义不清的问题。V1 也可以先由发布清单在外部保存 Manifest 哈希，避免在格式中引入循环计算。

## 五、缓存与资源预算

WeiSQL AI 需要同时管理 HTTP 缓存、应用层范围读取缓存，以及引擎内部缓存。不能把这些缓存简单视为同一层。

| 配置项                  | 作用              | 建议规则            |
| -------------------- | --------------- | --------------- |
| `maxCacheBytes`      | 应用层数据块缓存上限      | 可配置，超限采用 LRU 淘汰 |
| `maxConcurrentReads` | 并发读取数           | 使用信号量控制         |
| `maxRangeBytes`      | 单次范围读取最大字节数     | 拒绝超限请求或拆分读取     |
| `maxRows`            | 普通 SQL 查询结果行数上限 | 超限报错或要求使用流式接口   |
| `timeoutMs`          | 查询超时            | 结合引擎实际取消能力      |
| `maxFilterDepth`     | 过滤表达式最大深度       | 防止异常复杂表达式       |
| `maxFilterNodes`     | 过滤表达式节点数        | 限制解析与执行成本       |

这些值不应在没有基准测试的情况下统一写死为最终产品默认值。

### 5.1 缓存验收

- 同版本、同资源、同范围的重复请求可以命中缓存。
- 不同数据集版本不得共享可能产生内容混淆的缓存项。
- 取消的读取不能被缓存为成功结果。
- 数据损坏的资源不得因缓存而绕过必要的完整性校验。
- 关闭 Runtime 后应释放其拥有的缓存；共享缓存则必须有独立的所有权规则。

## 六、Manifest 与资源安全

### 6.1 路径校验

资源路径应遵循规范化的相对 POSIX 路径规则，例如：

```
data/documents.parquet
vectors/embeddings.f32
vectors/id-map.jsonl
vectors/id-map.offsets
```

必须拒绝绝对路径、`..` 路径段、空路径段、反斜杠、NUL、URL scheme 和不符合规范的编码路径。

Node.js 端还需要防范符号链接越界、文件替换和检查与使用之间的竞态；仅做字符串路径检查并不足够。

### 6.2 完整性检查分层

| 层级 | 检查内容                  | 能否证明数据可用  |
| -- | --------------------- | --------- |
| L1 | Manifest 结构           | 不能        |
| L2 | 路径和资源引用               | 不能        |
| L3 | 文件大小与哈希               | 证明字节与声明一致 |
| L4 | Parquet、ID 映射和向量文件可读取 | 部分证明      |
| L5 | 引擎成功执行查询及交叉验证         | 更接近实际可用性  |

即使 SHA-256 匹配，也不代表数据可信或发布者可信。发布者身份验证与签名清单属于单独的安全能力，可以在后续版本考虑。

## 七、全文检索与 RAG 的范围澄清

前面的规划提到了全文检索，但 V1 尚未冻结具体全文引擎，因此这里明确分层：

- V1 核心：SQL 查询、向量精确检索、结构化过滤、统一资源读取。
- V1 扩展接口：全文检索适配器、ANN 适配器、混合排序。
- 后续增强：关键词与向量融合、重排序器、查询改写和 AI 生成。
- 不属于 Runtime 核心职责：托管大语言模型、管理用户 API Key、自动生成嵌入向量，除非未来单独定义可选模块。

这样能够避免把“可与 AI/RAG 集成”误解为“数据库本身包含完整 AI 服务”。

## 八、补充验收用例

| 编号       | 测试场景              | 验收结果             |
| -------- | ----------------- | ---------------- |
| CONS-001 | 查询过程中调用 `close()` | 新请求立即被拒绝         |
| CONS-002 | 同时调用两次 `close()`  | 共用同一关闭流程         |
| CONS-003 | SQL 返回超大结果集       | 受行数或流式接口策略控制     |
| CONS-004 | 流式查询提前退出          | 游标与相关资源被释放       |
| CONS-005 | 发布指针切换版本          | 已打开实例继续使用原版本     |
| CONS-006 | 缓存中存在旧版本数据        | 新版本查询不会错误复用旧内容   |
| CONS-007 | 资源哈希不一致           | 返回明确的完整性错误       |
| CONS-008 | 路径通过符号链接逃逸根目录     | Node Reader 拒绝访问 |
| CONS-009 | 引擎不支持真正流式执行       | 能力或文档明确披露限制      |
| CONS-010 | 资源读取取消后再次请求       | 不把先前取消当作缓存成功结果   |

## 九、当前需求冻结建议

## V1 核心交付顺序

1. 先冻结公开接口和错误码：将 API 类型、查询结果、生命周期规则形成唯一规范。
2. 实现核心向量算法：距离计算、Top-K、分块精确检索和确定性测试。
3. 实现 Manifest 与 ResourceReader：先打通本地数据包，再实现浏览器 HTTP Range。
4. 接入 SQL 引擎：验证 DuckDB 与 DuckDB-Wasm 的只读、参数绑定和结果转换。
5. 最后实现混合检索和性能优化：以精确搜索作为基线，再决定 ANN 策略与索引格式。

接下来最有价值的工作是将上述规则整理为实际工程中的 `API.md`、`MANIFEST.md`、`ERRORS.md` 和 `ACCEPTANCE-TESTS.md`，然后用契约测试检查接口实现是否符合规范。到这一步，WeiSQL AI 就具备了从需求进入可持续编码的基础。

