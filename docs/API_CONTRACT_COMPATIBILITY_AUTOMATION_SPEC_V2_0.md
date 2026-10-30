# WeiSQL AI API 契约测试与兼容性自动化实施规范 V2.0

文档编号：WSAI-QA-002 · 版本：V2.0 · 状态：实施规范候选 · 关联文档：V1.7 测试策略、V1.8 数据包格式、V1.9 公共 SDK API

V1.9 冻结了公共 API 的设计。本阶段不再扩展 API，而是把接口、错误码、向量计算、数据包格式、资源生命周期和跨环境一致性转换为可自动执行的测试与发布门禁。

核心目标是：开发者修改任意一个模块后，CI 能够自动判断是否破坏了既有契约，而不是等到用户使用时才发现问题。

## 一、测试体系总体架构

### 开发提交与 Pull Request

代码、类型、Manifest、SDK API 变更

静态检查

TypeScript、Lint、格式、API 导出

单元测试

距离计算、Manifest、路径、Top-K

契约与兼容性

API 类型、错误码、版本兼容

集成测试

Node、浏览器、SQL、向量适配器

发布门禁

性能基准、损坏数据包、跨环境一致性、发布产物检查

### 1.1 测试等级

| 等级 | 测试类型                     | 执行时机                | 是否阻断合并   |
| -- | ------------------------ | ------------------- | -------- |
| L0 | 格式、Lint、类型检查             | 每次提交                | 是        |
| L1 | 单元测试                     | 每次提交                | 是        |
| L2 | API 契约、Manifest、错误码测试    | 每次提交                | 是        |
| L3 | Node.js 集成、真实 SQL/向量适配器  | Pull Request        | 是        |
| L4 | 浏览器、WASM、HTTP Range、故障注入 | Pull Request 或指定 CI | 核心场景必须通过 |
| L5 | 大数据性能、发布与兼容性回归           | 夜间、候选发布             | 发布前必须通过  |

这里的“必须通过”是目标门禁政策。当前尚未确认实际仓库、CI 工作流和测试执行结果，不能视为已经实施。

## 二、测试技术栈与工程配置

建议以 TypeScript 为主线，尽量减少多套测试框架带来的维护成本。

| 工具                    | 用途            | 采用建议                |
| --------------------- | ------------- | ------------------- |
| `Vitest`              | 单元、集成、契约测试    | 主测试框架               |
| `TypeScript`          | 公共 API 类型检查   | 所有公共包必须检查           |
| `ESLint`              | 静态规则          | 必须                  |
| `Prettier`            | 代码格式          | 必须                  |
| `Playwright`          | 浏览器真实环境测试     | Browser/WASM 集成阶段启用 |
| `fast-check`          | 属性测试、随机输入     | 向量和路径模块优先           |
| `API Extractor` 或同类工具 | 公共声明生成、API 报告 | API 冻结阶段启用          |
| GitHub Actions        | CI 编排         | 推荐默认实现              |

这些是建议采用的工具组合，不意味着当前仓库已经安装。

### 2.1 Monorepo 测试目录

```
weisql-ai/
├── packages/
│   ├── core/
│   │   └── src/
│   ├── manifest/
│   │   └── src/
│   ├── resource-reader/
│   │   └── src/
│   ├── runtime/
│   │   └── src/
│   ├── vector/
│   │   └── src/
│   ├── sql-duckdb/
│   │   └── src/
│   ├── sql-duckdb-wasm/
│   │   └── src/
│   └── testing/
│       ├── fixtures/
│       ├── generators/
│       ├── assertions/
│       └── contract/
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── contract/
│   ├── compatibility/
│   ├── browser/
│   ├── fault-injection/
│   └── performance/
├── fixtures/
│   ├── valid-package/
│   ├── invalid-manifest/
│   ├── invalid-vectors/
│   ├── corrupted-resources/
│   └── compatibility/
└── docs/
    └── qa/
        └── v2.0-test-plan.md
```

测试代码应尽可能与业务代码分离。公共测试工具放入 `packages/testing`，避免每个包重复造轮子。

## 三、API 契约自动化

### 3.1 公共 API 快照

对以下内容生成稳定的 API 报告：

- 公共导出名称。
- 导出类型及参数。
- 返回值和 Promise 类型。
- 错误码联合类型。
- 能力声明。
- SQL、向量和混合检索的请求与响应结构。

建议流程：

```
源码
  ↓
TypeScript 声明文件
  ↓
API 报告
  ↓
与主分支基线比较
  ↓
检测新增、删除、类型变化
  ↓
人工审核变更
```

任何意外删除公共导出、缩窄原有参数范围或改变返回类型的修改都应阻断 CI。

API 报告不是运行时行为测试的替代品。例如，`close()` 的类型签名保持不变，也可能在实现中被错误改为无法幂等调用。

### 3.2 编译级契约测试

建立独立的 TypeScript 测试项目，仅从公共入口导入 API。

```
import { open } from "@weisql-ai/node";
import type {
  OpenOptions,
  VectorSearchRequest,
  WeiSQLDatabase,
} from "@weisql-ai/core";

const options: OpenOptions = {
  source: "./fixtures/valid-package",
  integrity: "full",
};

const request: VectorSearchRequest = {
  collection: "documents",
  vector: [0.1, 0.2, 0.3],
  topK: 10,
};

async function verifyPublicContract() {
  const db: WeiSQLDatabase = await open(options);

  const response = await db.vector.search(request);

  response.results.forEach((item) => {
    const distance: number = item.distance;
    void distance;
  });

  await db.close();
}
```

这段代码是编译级测试样例，不是已运行的验证结果。实际执行前，测试包必须使用真实存在且已实现的导出。

### 3.3 契约测试规则

| 测试项        | 通过条件                           |
| ---------- | ------------------------------ |
| 公共导出       | 所有冻结的导出均可导入                    |
| 类型声明       | 使用者项目可独立编译                     |
| 错误类型       | 错误码是规定的联合类型                    |
| 引擎隔离       | 公共类型不包含引擎私有类型                  |
| Node 入口    | 不意外依赖浏览器全局对象                   |
| Browser 入口 | 不意外引入 Node.js 文件系统模块           |
| 包导出        | `exports`、`types`、ESM/CJS 策略一致 |
| 示例编译       | 官方文档代码通过 TypeScript 检查         |

## 四、错误码一致性测试

V1.9 已定义错误码。本阶段要验证的是：实际实现是否在正确的场景返回正确的错误，而不是仅仅检查字符串是否存在。

### 4.1 错误码测试矩阵

| 输入或故障                         | 预期错误码                        |
| ----------------------------- | ---------------------------- |
| 缺失必需参数                        | `INVALID_ARGUMENT`           |
| JSON 格式损坏                     | `INVALID_MANIFEST`           |
| 不支持的数据包格式                     | `UNSUPPORTED_FORMAT_VERSION` |
| 未启用的全文搜索                      | `UNSUPPORTED_CAPABILITY`     |
| 不存在的数据包                       | `PACKAGE_NOT_FOUND`          |
| 引用文件缺失                        | `RESOURCE_NOT_FOUND`         |
| 非法相对路径                        | `PATH_INVALID`               |
| 路径逃逸数据包根目录                    | `PATH_OUTSIDE_ROOT`          |
| Range 被服务器忽略且返回完整响应           | `RANGE_UNSUPPORTED`          |
| SHA-256 不匹配                   | `INTEGRITY_CHECK_FAILED`     |
| Parquet 与 Manifest Schema 不一致 | `SCHEMA_MISMATCH`            |
| 非法 SQL                        | `QUERY_INVALID`              |
| 向量维度不匹配                       | `VECTOR_DIMENSION_MISMATCH`  |
| 向量包含 NaN/Infinity             | `VECTOR_VALUE_INVALID`       |
| 请求度量与集合度量冲突                   | `VECTOR_METRIC_MISMATCH`     |
| ANN 索引无法加载                    | `VECTOR_INDEX_INVALID`       |
| 过滤字段不在白名单中                    | `FILTER_INVALID`             |
| 用户取消操作                        | `CANCELLED`                  |
| 超过操作超时时间                      | `TIMEOUT`                    |
| 已关闭的数据库执行查询                   | `RESOURCE_CLOSED`            |

重要： 上表中的错误映射是目标行为。实现中应明确区分“文件不存在”和“文件存在但内容损坏”，避免用一个宽泛错误覆盖所有情况。

### 4.2 统一错误断言

```
import { expect, test } from "vitest";
import { WeiSQLError } from "@weisql-ai/core";

export async function expectWeiSQLError(
  operation: () => Promise<unknown>,
  expectedCode: WeiSQLError["code"],
) {
  try {
    await operation();
  } catch (error) {
    expect(error).toBeInstanceOf(WeiSQLError);

    const actual = error as WeiSQLError;
    expect(actual.code).toBe(expectedCode);
    expect(actual.message.length).toBeGreaterThan(0);
    return;
  }

  throw new Error(`Expected WeiSQLError: ${expectedCode}`);
}

test("dimension mismatch returns stable error code", async () => {
  // 在 Runtime 和真实 fixture 接入后替换为实际调用。
  const operation = async () => {
    throw new WeiSQLError(
      "VECTOR_DIMENSION_MISMATCH",
      "Vector dimension does not match collection dimension.",
      "vector",
    );
  };

  await expectWeiSQLError(
    operation,
    "VECTOR_DIMENSION_MISMATCH",
  );
});
```

以上第二个测试仅演示断言工具的使用方式。它主动抛出错误，不能证明真实向量搜索实现已经正确；正式测试必须调用真实 SDK API。

### 4.3 禁止的测试写法

以下模式不能作为错误码验收的唯一依据：

```
// 不充分：只检查出现了某个错误字符串。
expect(String(error)).toContain("VECTOR_DIMENSION_MISMATCH");
```

应检查：

- 错误对象类型。
- 精确错误码。
- 分类是否符合规范。
- `retryable` 是否合理。
- 必需的上下文信息是否存在。
- 是否泄露敏感路径、密钥或 SQL 参数。

## 五、向量算法与数值属性测试

向量算法属于 WeiSQL AI 的核心基础层，必须使用确定性样例、随机属性测试和精确搜索基线三种方式验证。

### 5.1 距离函数单元测试

必须覆盖：

| 场景           | 预期行为                                 |
| ------------ | ------------------------------------ |
| 相同向量         | cosine distance 为 0；L2 为 0           |
| 正交向量         | cosine similarity 接近 0，distance 接近 1 |
| 反向向量         | cosine distance 接近 2                 |
| L2 已知距离      | 与手算欧氏距离一致                            |
| IP 度量        | `distance = -inner product`          |
| 维度不同         | 拒绝                                   |
| 空向量          | 拒绝                                   |
| cosine 零向量   | 拒绝                                   |
| NaN/Infinity | 拒绝                                   |
| 极大/极小有限数     | 不允许静默产生错误排序                          |
| 等距候选         | 按 `rowId` 升序                         |
| K 大于候选总数     | 返回全部有效候选                             |

### 5.2 属性测试

适合使用 `fast-check` 验证以下不变量：

1. L2 距离非负。
2. `distance(A, A)` 为零或在规定浮点误差内接近零。
3. L2 满足对称性。
4. cosine distance 对非零向量满足对称性。
5. 精确搜索返回的结果不超过 `topK`。
6. 返回结果按 `(distance, rowId)` 排序。
7. 相同输入与固定数据集得到相同的精确结果顺序。
8. Top-K 结果与独立的暴力计算基线一致。

浮点计算必须使用明确的绝对/相对误差容差，不能直接使用字符串比较或未经说明的精确相等断言。

### 5.3 Exact Search Oracle

为每个测试数据集实现独立、易理解的暴力搜索基线：

```
输入向量
   ↓
遍历所有候选
   ↓
计算标准距离
   ↓
按 distance、rowId 排序
   ↓
截取 Top-K
```

基线的首要目标是正确性，不是性能。ANN 测试必须与这套基线比较，而不能用另一个 ANN 结果作为唯一参考。

### 5.4 ANN 质量指标

采用 Recall\@K：

\\[ \operatorname{Recall\@K} = \frac{|A_K \cap E_K|}{|E_K|} \\]

其中：

- \\(A_K\\)：ANN 返回的 Top-K ID 集合。
- \\(E_K\\)：Exact Search 返回的 Top-K ID 集合。

当精确结果少于 K 条时，分母应使用实际精确结果数量；若没有精确结果，需单独定义空集处理，避免除零。

建议每个 benchmark 报告：

- Recall\@1、Recall\@10。
- P50/P95 查询延迟。
- 索引构建耗时。
- 索引文件大小。
- 运行峰值内存。
- 数据集行数、维度、度量和随机种子。
- 参数配置及运行环境。

不得在没有实际运行数据的情况下给出性能达标结论。

## 六、Manifest 与数据包测试

### 6.1 Fixture 规范

测试夹具分为有效、边界、无效和兼容性四类。

有效数据包

包含合法 Manifest、Parquet、向量文件、ID 映射与可选索引；可用于端到端验证。

边界数据包

零行表、单行向量集合、空可选索引、最大合法路径、最小有效文件。

损坏数据包

Manifest 截断、哈希不匹配、文件长度不匹配、非法向量数值、索引损坏、ID 偏移表错误。

兼容性数据包

不同 `formatVersion`、未知扩展字段、可选字段缺失和历史合法版本。

### 6.2 必须验证的完整性不变量

- `files` 是唯一权威文件清单。
- Manifest 中的引用都指向已声明文件。
- 文件路径符合 V1.8 路径规则。
- 实际字节长度与声明一致。
- SHA-256 校验使用实际读取的字节。
- 向量文件长度满足 `count × dimension × 4`。
- Float32 使用小端序。
- ID 偏移表含 N+1 个边界值，单调递增，首值为 0，末值等于 JSONL 文件字节长度。
- Parquet 实际 Schema 与 Manifest 声明兼容。
- ANN 索引元数据与向量集合、维度、度量和源向量哈希匹配。
- 不支持的格式版本必须明确拒绝。
- SHA-256 匹配不能被视为发布者身份认证。

### 6.3 Manifest 属性测试

随机生成合法和非法 Manifest：

- 文件 ID 重复。
- 文件路径重复。
- 缺失必需字段。
- 未知字段。
- 不合法的版本号。
- 文件大小为负数或非整数。
- 非法 SHA-256 格式。
- 引用不存在的文件。
- 向量维度为 0。
- 行数和文件长度不匹配。
- 路径编码绕过。
- 绝对路径、`..`、反斜杠、NUL 字符和 URL scheme。

对于 V1.8 是否允许未知字段，必须严格遵循其 Schema 中冻结的规则；不能在测试实现中擅自把“允许扩展字段”解释为“允许任意未定义的核心字段”。

## 七、资源读取与故障注入

资源读取层是 Node.js 和浏览器差异最大的部分，应使用统一契约测试分别验证两种实现。

### 7.1 ResourceReader 契约

每个资源读取器都应通过以下相同测试：

| 测试     | 预期行为           |
| ------ | -------------- |
| 正常读取文件 | 字节正确           |
| 读取范围   | 返回指定偏移与长度      |
| 超出文件末尾 | 按契约返回截断范围或明确错误 |
| 零长度范围  | 返回空字节数组        |
| 读取缺失资源 | 返回标准资源错误       |
| 并发读取   | 不出现数据串扰        |
| 关闭后读取  | 拒绝操作           |
| 重复关闭   | 安全完成           |
| 中途取消   | 尽可能停止工作并清理资源   |
| 文件被替换  | 按缓存与完整性策略识别变化  |

### 7.2 HTTP Range 专项测试

浏览器测试必须模拟以下服务端行为：

1. 正确返回 `206 Partial Content`。
2. 返回 `200 OK`，忽略 Range。
3. 返回错误的 `Content-Range`。
4. 返回比请求范围更长的响应。
5. 返回截断响应。
6. 请求期间连接中断。
7. 返回 `416 Range Not Satisfiable`。
8. CORS 不允许跨域请求。
9. 响应包含 ETag，并在资源更新后改变。
10. 返回缓存命中和缓存失效两种路径。

当服务器忽略 Range 并返回整个文件时，Runtime 不应误把完整文件当作请求的范围数据。

### 7.3 路径安全专项测试

Node.js 读取器需要额外测试：

- 符号链接指向数据包根目录之外。
- 目录结构在验证后被替换。
- 路径包含编码和分隔符混淆。
- 多个并发任务争用同一个临时资源。
- 数据包发布时出现文件缺失。
- `realpath` 校验与实际打开文件之间发生竞争。

仅使用字符串前缀判断路径是否位于根目录内是不充分的，例如 `/data/pkg-evil` 可能以 `/data/pkg` 开头，却不是该目录的子路径。实现必须采用规范化路径和根目录边界检查，并处理符号链接与检查/使用之间的竞争。

## 八、Runtime 生命周期与取消测试

建立明确的状态转移测试：

```
CREATED → OPENING → READY → CLOSING → CLOSED
                    └──────────────→ FAILED
```

测试矩阵：

| 场景              | 预期结果                 |
| --------------- | -------------------- |
| 正常打开            | 进入 READY             |
| Manifest 解析失败   | 打开失败，清理临时资源          |
| 引擎初始化失败         | 打开失败，不泄漏已创建资源        |
| READY 后执行查询     | 正常执行                 |
| READY 时调用 close | 进入 CLOSING 并完成清理     |
| 重复调用 close      | 幂等完成                 |
| CLOSED 后发起新查询   | `RESOURCE_CLOSED`    |
| OPENING 时取消     | 初始化尽可能中止，资源被清理       |
| 查询执行时取消         | `CANCELLED`，不再推进后续工作 |
| 查询超时            | `TIMEOUT`            |
| 关闭期间提交新查询       | 拒绝新操作                |
| 多个请求并发关闭        | 不发生重复释放或状态倒退         |

注意： 取消信号被触发，不等于底层数据库任务已经停止。测试必须检查实际的任务终止行为、资源占用和清理结果。

## 九、Node.js 与浏览器一致性测试

目标不是要求所有引擎内部算法完全相同，而是保证公共契约规定的结果和错误行为一致。

### 9.1 统一测试语料

使用同一个 fixture 运行两套环境：

```
fixtures/valid-package
        │
        ├── Node.js Runtime
        │
        └── Browser Runtime
```

分别比较：

- Manifest 解析结果。
- SQL 列名、类型、行数和记录内容。
- 参数绑定结果。
- 向量距离。
- Exact Search 的 Top-K ID 与排序。
- 结构化过滤结果。
- 混合检索策略标识。
- 错误码。
- `close()` 后的行为。

### 9.2 数值比较策略

| 比较对象            | 规则                           |
| --------------- | ---------------------------- |
| ID、列名、错误码       | 精确相等                         |
| 行数、维度、文件大小      | 精确相等                         |
| Float32 解码      | 规定的浮点容差                      |
| Exact Search 排序 | 按冻结规则比较                      |
| ANN Top-K       | 使用 Recall\@K，不要求不同后端 ID 完全一致 |
| 时间与内存           | 独立记录，不要求跨环境数值相等              |

如果两种环境对同一输入产生不同的精确搜索结果，必须先排查浮点舍入、NaN 处理、距离实现和并列排序规则，而不是简单扩大误差容忍范围。

## 十、性能回归与资源上限测试

### 10.1 固定基准矩阵

| 规模 | 向量数       | 维度  | Float32 原始向量大小 |
| -- | --------- | --- | -------------- |
| S  | 100,000   | 768 | 307.2 MB       |
| M  | 500,000   | 768 | 1.536 GB       |
| L  | 1,000,000 | 768 | 3.072 GB       |

这里采用十进制 MB/GB 计算，不包括 ID 映射、Parquet、ANN 索引、临时副本和运行时开销。

每组测试应分别测量：

- 构建时间。
- 打开时间。
- 首次查询时间。
- 热缓存查询时间。
- P50/P95 查询延迟。
- 峰值内存。
- 缓存命中率。
- Range 请求数量与总传输字节。
- ANN Recall\@K。
- 关闭后的资源释放情况。

### 10.2 阻断规则

性能门槛必须在真实基准数据产生后冻结，不应凭估算直接规定一个“必须达到”的毫秒数。

初期建议采用以下规则：

1. 同一硬件、同一数据集、同一参数下与基线比较。
2. 对 P50/P95、内存、构建时间和索引大小设置独立门槛。
3. 超过回归阈值时自动附带基线对比报告。
4. 性能测试未执行、测试环境失效与性能不达标应是不同状态。
5. 夜间大规模测试可以与快速 PR 测试分开，但候选发布必须通过完整基准。

## 十一、CI 工作流设计

建议将 CI 分成快速检查、集成测试和发布验证三个工作流。

### 11.1 Pull Request 工作流

```
name: Pull Request Checks

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  static:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck
      - run: pnpm test:unit
      - run: pnpm test:contract
```

这是建议的工作流模板，不是已验证可直接运行的配置。使用前需确认仓库的实际脚本、Node.js 支持范围、pnpm 版本、依赖安装方式和许可证要求。GitHub Actions 的 `uses` 版本还应按团队的依赖固定与供应链安全策略管理。

### 11.2 建议脚本

```
{
  "scripts": {
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test:unit": "vitest run tests/unit",
    "test:contract": "vitest run tests/contract",
    "test:integration": "vitest run tests/integration",
    "test:browser": "playwright test",
    "test:fault": "vitest run tests/fault-injection",
    "test:performance": "vitest run tests/performance",
    "test:all": "pnpm lint && pnpm typecheck && pnpm test:unit && pnpm test:contract && pnpm test:integration"
  }
}
```

`test:all` 的具体内容应随项目进度调整。浏览器测试和性能测试通常需要单独的环境与资源，不建议在尚未实现对应适配器时就把它们配置成虚假通过。

### 11.3 发布门禁

G1

静态检查

全部公共包类型检查、Lint、导出检查通过

G2

基础正确性

Manifest、距离函数、Top-K、ID 映射单元测试通过

G3

公共契约

API 报告无未经批准的破坏性变更

G4

运行时验证

Node.js 与真实 SQL/向量适配器集成测试通过

G5

浏览器验证

Range、CORS、WASM、取消和资源释放测试通过

G6

完整性与安全

损坏数据包、路径逃逸、哈希校验测试通过

G7

性能与质量

基准报告齐全且满足已批准门槛

G8

发布产物

npm 包、类型声明、Manifest 示例和文档检查通过

只有所有适用的门禁通过，才允许发布候选版本。对尚未实现的模块，应明确标记为“未就绪”，而不是跳过测试后把它算作通过。

## 十二、V2.0 实施任务拆分

| 阶段 | 任务          | 交付物                | 验收标准          |
| -- | ----------- | ------------------ | ------------- |
| M0 | 测试工程初始化     | Vitest、TS、Lint 配置  | 本地命令可运行       |
| M1 | 公共 API 报告   | API baseline       | 导出和类型变化可检测    |
| M2 | 错误码测试       | 错误码矩阵、断言工具         | 关键错误映射通过      |
| M3 | Manifest 测试 | 合法/损坏 fixtures     | 结构、引用、哈希规则通过  |
| M4 | 向量测试        | Exact Oracle、属性测试  | 距离与 Top-K 正确  |
| M5 | 资源读取测试      | Node/HTTP Range 契约 | 范围、缓存、关闭行为正确  |
| M6 | Runtime 集成  | Node/Browser 一致性报告 | 同一测试语料符合契约    |
| M7 | 故障注入        | 失败场景测试套件           | 部分失败可恢复且无错误发布 |
| M8 | 性能基准        | 规模与延迟报告            | 建立可重复的性能基线    |
| M9 | 发布门禁        | CI 与候选发布流程         | 未通过关键门禁时禁止发布  |

推荐实施顺序是先 M0–M4，随后 M5–M6，再实施 M7–M9。这样能够先验证最重要的类型契约、数据格式和算法正确性，避免在核心接口尚不稳定时投入大量浏览器与性能测试工作。

## 十三、本阶段完成定义

V2.0 文档完成不等于测试体系已经完成。实际工程验收必须至少具备：

- 测试工程能够安装依赖并运行。
- API 报告可以自动生成和比较。
- 公共错误码有真实调用路径的测试。
- Exact Search 有独立参考实现。
- Manifest fixtures 覆盖合法、边界与损坏场景。
- Node.js 资源读取器通过统一契约测试。
- 浏览器 Range 行为经过真实 HTTP 环境验证。
- 生命周期与取消测试检查实际资源释放。
- 性能基准记录可重复的运行条件。
- CI 能够阻止关键测试失败后的合并或发布。

下一步建议： 进入《WeiSQL AI TypeScript Monorepo 工程初始化与首批代码实施规范 V2.1》，开始把现有设计转成真实目录、`package.json`、`tsconfig`、Vitest 配置、Manifest Schema 和第一批可运行单元测试。

