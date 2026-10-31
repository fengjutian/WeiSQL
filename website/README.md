# WeiSQL AI 文档站

基于 Docusaurus 3 的静态文档站，内容在 `content/`，构建产物在 `build/`。

## 本地开发

```bash
cd website
npm install
npm run dev        # http://127.0.0.1:3000
```

构建与预览：

```bash
npm run build
npm run serve      # 预览 build/ 产物
```

## 目录

```text
website/
├── content/                 # 产品文档（Markdown）
├── src/css/custom.css       # 品牌色与排版
├── static/img/              # logo / favicon
├── docusaurus.config.js     # 站点、导航、搜索插件
├── sidebars.js              # 手工侧边栏
├── netlify.toml             # 若将 base 设为 website，可独立部署
└── CONTENT-GUIDE.md         # 写作规范
```

仓库根目录另有 `netlify.toml`，其中 `base = "website"`，用于从仓库根触发 Netlify 构建。

## 部署到 Netlify

1. Netlify 新建站点并连接本仓库；
2. 构建命令 `npm run build`，发布目录 `build`，Base directory `website`（或直接使用根目录的 `netlify.toml`）；
3. Node 版本 22（`netlify.toml` 已声明）；
4. 首次部署后，把 `docusaurus.config.js` 里的 `url` 改成实际域名。

## 搜索

使用 `@easyops-cn/docusaurus-search-local`，构建期生成索引，浏览器本地检索；中文分词由 `@node-rs/jieba` 提供，不依赖 Algolia 或任何外部服务。

`hashed: false` 是为了避免“二次构建才能得到稳定索引文件名”的问题；索引的缓存策略由 `netlify.toml` 的 `/*search-index*` 头控制。

插件自带的 zh trimmer 只保留汉字，会把 `SQL`、`CTE`、`DuckDB` 这类英文技术词裁掉。`scripts/patch-search-trimmer.mjs` 在 `postinstall` 中把 `A-Za-z0-9_` 加入允许字符集；脚本幂等，找不到预期文本会直接失败，避免插件升级后静默失效。

## 内容约定

新增页面前先读 `CONTENT-GUIDE.md`。要点：

- 只写“怎么用”，规范与 ADR 留在仓库根 `docs/`；
- frontmatter 必须有 `title`、`description`、`sidebar_position`；
- 正文不要重复一级标题；
- 站内链接用根路径（如 `/sdk/sql`）；
- 未验证的能力必须明确标注。
