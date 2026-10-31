# WeiSQL 文档站内容规范

本目录 (`website/content`) 是面向使用者的产品文档源文件。仓库根目录的 `docs/` 是工程规范与 ADR 的唯一事实源，两者分工如下：

- `website/content`：教程、使用指南、参考速查。回答“怎么用”。
- `docs/`：格式规范、契约、验收计划、技术决策。回答“为什么这样定”。

不要把 `docs/` 的规范全文复制到站点；需要深挖时在页尾“延伸阅读”链接到 GitHub 原文。

## 事实来源优先级

1. 源码与测试：`packages/*/src`、`packages/*/test`
2. `README.md`、`packages/*/README.md`
3. `docs/PROJECT_STATUS.md`（只陈述已验证内容）
4. 契约类文档：`SDK_API_CONTRACT_V1.md`、`PUBLIC_TYPES_AND_ERRORS_V1.md`、`RESOURCE_READER_CONTRACT.md`、`SQL_ADAPTER_CONTRACT.md`、`VECTOR_ADAPTER_CONTRACT.md`
5. 专项设计：`MANIFEST_SPEC_V1.md`、`WSQL_CONTAINER.md`、`FULL_TEXT_SEARCH.md`、`DUCKDB_ADAPTER.md`、`DUCKDB_WASM_ADAPTER.md`、`USEARCH_ADAPTER.md`、`TABLE_LOADING_OPTIONS.md`、`BENCHMARK_HARNESS.md`
6. 标注“目标态/与当前仓库存在差异”的 V0.9–V2.0 规范：**只可作为背景，不得当作已实现行为**

冲突时以实现为准。

## Frontmatter

```yaml
---
title: 页面标题
description: 一句话说明本页解决什么问题（40–80 字）
sidebar_position: 22
---
```

正文不要重复一级标题，直接从导语或 `##` 开始。

## 视觉组件（.mdx）

需要首页级别的排版时，把页面写成 `.mdx`，并从 `@site/src/components/docs/DocsUI` 导入：

- `PageHero`：顶部渐变区，替代默认标题（frontmatter 加 `hide_title: true`）；
- `CardGrid` / `DocCard`：两列或三列卡片，`to` 可选；
- `LayerStack`：带编号与标签的分层列表；
- `FlowSteps`：步骤卡片，`columns={2}` 或默认 3 列；
- `Callout`：提示块，`tone="amber"` 表示警告。

如果页面只需要一个 Hero、正文仍是普通 Markdown，可以直接用 frontmatter，不必改成 MDX：

```yaml
hero:
  kicker: SDK · 检索
  title: 精确向量，先过滤再比较
  lead: 一句话说明本页解决什么问题。
  chips: [Float32, Top-K, filter]
hide_title: true
```

`src/theme/DocItem/Content` 会读取 `hero` 并渲染 `PageHero`；没有 `hero` 的页面保持默认标题。

示例：

```mdx
---
title: 架构
hide_title: true
---

import { PageHero, CardGrid, DocCard } from "@site/src/components/docs/DocsUI";

<PageHero kicker="架构" title="..." lead="..." chips={["只读", "Adapter"]} />

## 分层

<CardGrid columns={2}>
  <DocCard title="..." index="01">...</DocCard>
</CardGrid>
```

## 页面骨架

教程/指南页：

1. 一句话定位：这页讲什么、读完后能做什么
2. 最小可运行示例
3. 选项/参数表
4. 行为与边界（含“未验证”）
5. 常见错误与排查
6. 延伸阅读

参考页：以表格为主，先给结论，再给字段/取值说明。

## 写作约定

- 简体中文；技术名词保留英文原词（Manifest、Adapter、Runtime、Top-K、BM25、RRF）。
- 中英文之间、数字与单位之间加空格。
- 代码块必须标语言：`ts`、`bash`、`json`、`text`。
- 命令统一用 `npm run ...` 或 `npx weisql ...`；路径用 POSIX 风格。
- 代码示例只使用真实存在的公开 API；参数名与类型必须和 `packages/sdk/src` 一致。
- 不编造未实现的功能、选项、默认值。
- 不承诺未经测量的性能；引用数字必须带条件（规模、维度、环境）。
- 明确区分“已实现”“已测试”“未验证”“明确不做”。
- 安全相关必须写明前提：只读、参数绑定、路径 containment、静态包可公开下载。

## 链接

- 站内链接用 `/docs` 前缀的根路径：`/docs/sdk/vector-search`、`/docs/reference/manifest`。
- 规范外链用 `https://github.com/fengjutian/WeiSQL/blob/main/docs/<file>.md`。
- 不链接尚不存在的页面。

## 术语

| 术语 | 含义 |
| --- | --- |
| 数据包（package） | 一个目录或 `.wsql` 文件，含 Manifest 与全部资源 |
| Manifest | 描述表、向量集合、文本索引、资源路径与摘要的 JSON |
| Runtime | `open()` 返回的只读数据库对象 |
| Adapter | 注入式引擎实现（SQL / 向量），SDK 本身不绑定引擎 |
| L1/L2 | 结构校验与语义/跨字段校验 |
| L3 | 资源完整性：尺寸 + SHA-256 |
| L4 | Parquet 内容与 Manifest 列定义的一致性校验 |
