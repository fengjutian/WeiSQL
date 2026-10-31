---
title: ADR：文档站框架选型
description: 记录 WeiSQL 文档站选择 Docusaurus 3.10 与离线中文搜索的决策过程、候选对比、后果与备选触发条件。
sidebar_position: 60
---

| 项目 | 内容 |
| --- | --- |
| 状态 | 已接受（Accepted） |
| 日期 | 2026-10-31 |
| 范围 | `website/` 文档站，不涉及 SDK 运行时 |
| 决策 | Docusaurus 3.10 + `@easyops-cn/docusaurus-search-local` + Netlify |
| 取代 | 无 |
| 后续 | 若团队统一 Next.js 或需要 3 个以上并行版本文档，重新评估 |

## 背景

仓库根目录的 `docs/` 是规范与 ADR 的事实源，但它面向贡献者：满篇“与当前仓库的差异”“尚未完成”，不适合作为使用者入口。我们需要一个独立的产品文档站，回答“怎么用”，同时保留“为什么这样定”跳回 GitHub 原文的路径。

站点要满足几个现实条件：

- 读者主要是中文用户，搜索必须对中文可用；
- 团队熟悉 React，希望文档站能用 React 组件写交互示例；
- 站点自身是静态产物，部署在 Netlify；
- 项目处于预发布阶段，只有一条文档主线，但不想在需要多版本时推倒重来；
- 文档构建不能把 DuckDB、USearch 的原生依赖拖进来。

这不是一个“哪个框架最流行”的问题，而是“哪个框架在我们最弱的约束上不掉链子”。最弱的约束是**离线中文搜索**。

## 约束

| 编号 | 约束 | 说明 |
| --- | --- | --- |
| C1 | 中文优先 | 界面、内容、搜索都以简体中文为主 |
| C2 | React 生态 | 允许在 Markdown 里嵌入 React 组件 |
| C3 | 纯静态托管 | 产物是静态文件，可部署 Netlify，不依赖常驻服务 |
| C4 | 与 Node/TS 工具链兼容 | 复用现有 npm/TypeScript 习惯 |
| C5 | 预留版本化路径 | 当前单版本，但迁移成本要可控 |
| C6 | 构建隔离 | 文档构建不引入运行时原生依赖 |

## 候选方案

决策时考察了六个候选：Docusaurus 3.10、Nextra 4.6、VitePress 1.6、Starlight 0.42、MkDocs Material、Docsify。

| 候选 | 中文搜索 | React | 静态托管 | 版本化 | 工具链 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| Docusaurus 3.10 | 插件 + jieba，离线可用 | 原生 | 是 | 内置 | Node/TS | 选中 |
| Nextra 4.6 | 需额外验证 | 原生 | 是 | 需额外方案 | Node/TS | 备选 |
| VitePress 1.6 | 本地搜索无 CJK 分词 | 非 React | 是 | 需插件 | Node/TS | 排除 |
| Starlight 0.42 | Pagefind 中文分词好 | 非 React | 是 | 插件 | Node/TS | 因 C2 排除 |
| MkDocs Material | 需 jieba 插件 | 非 React | 是 | 插件 | Python | 排除 |
| Docsify | 运行时渲染，无构建期索引 | 非 React | 是 | 无 | 前端 | 排除 |

表中的“是/否”是能力判断，不是评分；本 ADR 没有做任何定量基准测试。

## 关键发现

### 中文搜索是分水岭

- **VitePress** 的本地搜索基于 MiniSearch，按空白与标点切词，没有 CJK 分词。中文段落往往整段成为一个 token，实际表现为“搜不到”。
- **Starlight** 用 Pagefind，中文分词表现好，是纯静态文档站里搜索体验最省心的方案之一；但它是 Astro 生态，不满足 C2。
- **Docusaurus** 官方搜索依赖 Algolia（外部服务），但 `@easyops-cn/docusaurus-search-local` 在构建期生成索引，底层用 `@node-rs/jieba` 做中文分词，离线可用。
- **Nextra** 更轻，但中文搜索与版本化都需要额外验证，不能在决策时就当作已满足。

### 版本化与 i18n 是加分项，不是主因

Docusaurus 内置版本化与 `zh-Hans` i18n。当前只有一条文档主线，用不到多版本；但 C5 要求“将来需要时不必换框架”，这一条它满足得最直接。

### 构建隔离必须显式设计

仓库根 `package.json` 的 workspace 里包含 DuckDB、USearch 等带原生绑定的包。如果文档站直接加入根 workspaces，`npm install` 会把原生依赖带进文档构建环境，在 CI 或 Netlify 上增加失败面。因此文档站使用**独立的 `package.json` 与 lockfile**。

## 决策

采用 **Docusaurus 3.10**，配合 `@easyops-cn/docusaurus-search-local` 做离线中文搜索，部署到 Netlify。

具体接线：

| 项 | 取值 |
| --- | --- |
| 站点根目录 | `website/` |
| 内容目录 | `website/content/` |
| 路由 | 文档挂在根路径（`/start/what-is-weisql` 这类） |
| 搜索 | 构建期生成本地索引，无外部服务 |
| Netlify `base` | `website` |
| Netlify `publish` | `build` |
| Netlify `NODE_VERSION` | `22` |
| 依赖管理 | 独立 `package.json` + lockfile，**不加入根 workspaces** |
| 中英混排检索 | `postinstall` 补丁扩展 zh trimmer 的字符集，保留英文技术词 |

内容分工保持不变：

- `website/content` 写“怎么用”，页面骨架与写作约定见 `website/CONTENT-GUIDE.md`；
- 根 `docs/` 继续写“为什么这样定”，是规范与 ADR 的唯一事实源；
- 需要深挖时链回 GitHub 原文，而不是把规范全文复制到站点。

## 后果

### 正面

- 中文搜索离线可用，不依赖 Algolia 账号、爬虫或网络；
- React 组件可直接用于交互示例，与团队技能匹配；
- 版本化与 i18n 是内置能力，将来加多版本不需要换框架；
- 站点是纯静态产物，Netlify 部署简单；
- 文档依赖与运行时依赖隔离，原生绑定不会进入文档构建。

### 负面

- 搜索索引在构建期生成；Docusaurus 的本地搜索输出带 hash，**需要二次构建**才能让索引指向最终文件名；
- 构建时间随页数增长，页数上来后需要评估 `@docusaurus/faster`；
- 搜索插件是社区维护，`@node-rs/jieba` 是原生模块，升级时要验证平台兼容性；
- 插件的 zh trimmer 默认只保留汉字，会裁掉 SQL、CTE、DuckDB 等英文词项；站点用 `scripts/patch-search-trimmer.mjs` 在安装后扩展字符集，插件升级时需要重新核对；
- Docusaurus 的配置面比 VitePress 大，维护成本更高；
- 中文分词效果取决于 jieba 词典，专业术语可能需要自定义词典。

### 中性

- 文档站与 SDK 版本解耦：站点可以独立部署，不必跟包版本同步；
- 内容使用 Markdown + frontmatter，迁移到其他框架的成本主要是链接与组件改写。

## 备选触发条件

出现以下情况时重新评估，而不是继续加补丁：

| 触发条件 | 备选方案 | 理由 |
| --- | --- | --- |
| 团队统一到 Next.js | Nextra | 减少框架数量；但必须先验证中文搜索与版本化 |
| 需要 3 个以上并行版本文档 | 仍优先 Docusaurus | 内置版本化比插件组合更稳；只有维护成本明显过高才换 |
| 放弃 React 约束 | Starlight | Pagefind 的中文搜索更省心，Astro 构建更轻 |
| 搜索插件停止维护或 jieba 无法升级 | 自建 Pagefind 索引 | 保留静态搜索，代价是放弃 React 内嵌搜索 UI |
| 文档站需要运行时后端 | 重新立项 | 当前架构假设纯静态，加后端会改变部署与安全模型 |

## 未验证与不做的比较

- 没有对六个候选做构建时间、包体积或搜索延迟的定量对比；本 ADR 的结论来自能力与约束匹配，不是基准测试。
- 候选版本号是决策时的版本，后续升级不改变结论，但需要重新验证搜索插件。
- 没有验证 Nextra 的中文搜索与版本化细节，因此它只是备选，不是等价方案。
- 没有评估 Docusaurus 在数百页规模下的构建耗时；这是已知的待观察项。
