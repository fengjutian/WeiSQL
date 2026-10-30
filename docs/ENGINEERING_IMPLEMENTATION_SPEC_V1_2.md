# WeiSQL AI 工程实施规范 V1.2

## 一、冻结 Monorepo 工程结构

建议采用 pnpm Workspace + TypeScript + Rust。先把 TypeScript 核心跑通，再分别实现浏览器和 Node.js 适配器，避免一开始就同时引入 SQL 引擎、WASM、Rust 和向量索引造成调试困难。

```
weisql-ai/
├── apps/
│   ├── playground/              # React + TypeScript 演示应用
│   └── docs/                    # 文档网站
├── packages/
│   ├── core/                    # 错误码、公共类型、向量算法
│   ├── manifest/                # Manifest Schema 与语义校验
│   ├── resource-reader/         # 资源读取接口、范围校验
│   ├── runtime/                 # open、close、生命周期管理
│   ├── vector/                  # 精确搜索、Top-K、ID 映射
│   ├── sql-duckdb/              # Node.js SQL 适配器
│   ├── sql-duckdb-wasm/         # 浏览器 SQL 适配器
│   ├── vector-usearch/          # 可选 ANN 适配器
│   ├── builder/                 # 数据导入、构建、验证与发布
│   └── testing/                 # 公共测试夹具和测试辅助工具
├── crates/
│   └── weisql-core/             # 后续 Rust 核心实现
├── fixtures/
│   ├── valid-package/           # 合法最小数据包
│   └── invalid-packages/        # 损坏、缺失、版本错误等夹具
├── docs/
│   ├── requirements/
│   ├── architecture/
│   ├── api/
│   └── decisions/
├── pnpm-workspace.yaml
├── package.json
├── tsconfig.base.json
├── vitest.workspace.ts
└── README.md
```

这是目标目录结构。各子包应按阶段创建，不要求首轮就实现所有目录。

## 二、包职责与依赖关系

| 模块                | 主要职责                         | 不应承担的职责              |
| ----------------- | ---------------------------- | -------------------- |
| `core`            | 公共类型、错误码、向量距离、基础验证           | 不直接访问文件系统或网络         |
| `manifest`        | JSON 结构验证、引用关系、格式版本校验        | 不负责执行 SQL            |
| `resource-reader` | 读取字节范围、文件元信息、缓存接口            | 不解释业务数据              |
| `vector`          | 分块读取、精确 Top-K、ID 映射          | 不依赖具体 ANN 引擎         |
| `runtime`         | 组合各适配器、生命周期、能力查询             | 不绑定 DuckDB 内部类型      |
| `sql-duckdb`      | Node.js SQL 执行与结果转换          | 不实现公开 SDK            |
| `sql-duckdb-wasm` | 浏览器 SQL 执行                   | 不假设浏览器可以使用 Node 原生模块 |
| `vector-usearch`  | 可选近似最近邻索引                    | 不决定公共结果结构            |
| `builder`         | 生成 Parquet、向量文件、Manifest 和索引 | 不绕过最终验证直接发布          |
| `playground`      | 数据包加载、查询演示、错误展示              | 不承载数据库核心逻辑           |

依赖必须保持单向：`runtime` 可以组合 `core`、`manifest`、`resource-reader` 和引擎适配器；底层核心包不能反向依赖应用层或具体业务界面。

## 三、Workspace 基础配置

根目录 `package.json`：

```
{
  "name": "weisql-ai",
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "scripts": {
    "build": "pnpm -r --if-present build",
    "test": "pnpm -r --if-present test",
    "typecheck": "pnpm -r --if-present typecheck",
    "lint": "pnpm -r --if-present lint"
  },
  "devDependencies": {
    "typescript": "^5.8.3",
    "vitest": "^3.1.1"
  }
}
```

`pnpm-workspace.yaml`：

```
packages:
  - "apps/*"
  - "packages/*"
```

`tsconfig.base.json`：

```
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "skipLibCheck": true
  }
}
```

版本号只是工程起始建议。实际仓库应固定并验证 Node.js、pnpm、TypeScript、Vitest 以及各数据库引擎的兼容版本，不能把配置中的版本范围当作已经验证的兼容矩阵。

## 四、V1 实施阶段与交付物

### 阶段 A：核心契约

P0

交付物： `core`、`manifest`、错误码、基础类型、Manifest 校验测试。

验收： 不依赖 SQL 引擎即可验证数据包格式与引用关系。

### 阶段 B：本地只读 Runtime

P0

交付物： Node 文件读取器、向量分块读取、精确搜索、ID 映射。

验收： 使用最小数据集完成端到端精确向量搜索。

### 阶段 C：浏览器与静态部署

P0

交付物： HTTP Range Reader、DuckDB-Wasm 适配器、浏览器演示。

验收： 在目标 CDN 或 Netlify 环境验证 CORS、Range、WASM 加载和资源缓存。

### 阶段 D：SQL 与混合查询

交付物： 参数化 SQL、结构化过滤、`hybrid.search()`。

验收： 精确过滤优先策略与独立基准结果一致。

### 阶段 E：性能与发布

交付物： Builder、性能基准、文档、版本化发布流程。

验收： 完整性、性能、兼容性与失败恢复测试通过后，才定义正式支持范围。

## 五、V1 核心验收清单

## 项目验收追踪

0/12

工程

Workspace 安装、构建、类型检查与测试命令可用

格式

Manifest 结构、路径和资源引用校验正确

向量

Cosine、L2、IP 距离符合规范

精确搜索

与暴力排序基准一致，包含稳定平局排序

数据完整性

缺失文件、错误长度、哈希错误能够被发现

生命周期

取消、关闭、重复关闭和并发查询行为明确

Node.js

真实路径约束与符号链接安全测试通过

浏览器

Range、CORS、WASM 与缓存行为经过目标环境测试

SQL

只读限制、参数绑定和结果转换验证通过

混合查询

过滤后的全局 Top-K 保证经过独立基准验证

性能

100K、500K、1M 数据集均有可复现测试报告

发布

构建失败不产生可被误认为完整版本的产物

复制验收清单

此清单用于人工跟踪，不代表这些项目已经实现或测试通过。

## 六、需要提前规避的技术风险

| 风险                    | 影响              | 处理方案                        |
| --------------------- | --------------- | --------------------------- |
| DuckDB-Wasm 全量物化数据    | 浏览器内存占用过高       | 验证按需读取、投影裁剪及引擎缓存策略          |
| 原生 USearch 无法直接运行于浏览器 | 浏览器和 Node 能力不一致 | 通过独立适配器和能力查询处理              |
| Rust/WASM 额外维护成本      | 首版进度与调试复杂度增加    | 先用 TypeScript 实现正确性基线，再测量瓶颈 |
| CDN 不支持有效 Range       | 大数据无法高效按需加载     | 部署验收中单独验证，必要时提供可配置回退        |
| ANN 召回不稳定             | 搜索结果可能遗漏        | 使用精确检索计算 Recall\@K          |
| Manifest 版本演进         | 新旧客户端不兼容        | 格式版本和数据集版本分开管理              |
| 超大 SQL 结果             | 内存溢出            | 行数限制、分页和流式查询                |
| 跨版本缓存污染               | 查询结果不一致         | 缓存键绑定不可变数据集版本               |

## 七、接下来进入什么阶段？

我建议下一步进入 阶段 A：真正编写 `packages/core` 和 `packages/manifest` 的完整实现，而不是继续扩展架构图。

首批代码应包含：

1. 稳定错误类型与错误码。
2. Manifest TypeScript 类型和正式 JSON Schema。
3. 路径安全校验及资源引用检查。
4. 向量描述符、ID 映射与资源字节数一致性校验。
5. Vitest 边界测试和无效数据包测试。
6. 与后续 Builder、Runtime 共用的测试夹具。

完成这部分后，WeiSQL AI 就会从一组设计草案转变为可验证的基础工程；再向下接入资源读取和 SQL 引擎，风险会更低。

