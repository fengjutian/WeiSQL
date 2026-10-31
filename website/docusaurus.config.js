// @ts-check
const { themes } = require("prism-react-renderer");

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: "WeiSQL AI",
  tagline: "面向静态网站与嵌入式 AI 应用的只读数据运行时",
  favicon: "img/favicon.svg",

  // 部署到 Netlify 后改成实际域名。
  url: "https://weisql.netlify.app",
  baseUrl: "/",

  organizationName: "fengjutian",
  projectName: "WeiSQL",

  onBrokenLinks: "throw",
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: "warn",
    },
  },

  i18n: {
    defaultLocale: "zh-Hans",
    locales: ["zh-Hans"],
  },

  presets: [
    [
      "classic",
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          path: "content",
          routeBasePath: "/docs",
          sidebarPath: "./sidebars.js",
          editUrl: "https://github.com/fengjutian/WeiSQL/edit/main/website/",
          showLastUpdateTime: true,
          breadcrumbs: true,
          rehypePlugins: [require("./src/plugins/rehype-table-wrapper.js")],
        },
        blog: false,
        theme: {
          customCss: "./src/css/custom.css",
        },
      }),
    ],
  ],

  themes: [
    [
      require.resolve("@easyops-cn/docusaurus-search-local"),
      /** @type {import('@easyops-cn/docusaurus-search-local').PluginOptions} */
      ({
        hashed: false,
        language: ["zh"],
        docsRouteBasePath: "/docs",
        indexBlog: false,
        indexPages: false,
        highlightSearchTermsOnTargetPage: true,
        searchResultLimits: 8,
        searchResultContextMaxLength: 60,
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: "img/social-card.png",
      metadata: [
        {
          name: "keywords",
          content:
            "WeiSQL, 只读数据运行时, 静态数据包, 向量检索, BM25, RAG, DuckDB-Wasm, 边缘检索",
        },
      ],
      colorMode: {
        defaultMode: "light",
        disableSwitch: false,
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: "WeiSQL AI",
        logo: {
          alt: "WeiSQL AI",
          src: "img/logo.svg",
        },
        items: [
          {
            type: "docSidebar",
            sidebarId: "docs",
            position: "left",
            label: "文档",
          },
          {
            to: "/docs/start/quickstart",
            label: "快速开始",
            position: "left",
          },
          {
            to: "/docs/examples",
            label: "示例",
            position: "left",
          },
          {
            to: "/docs/architecture",
            label: "架构",
            position: "left",
          },
          {
            to: "/docs/api",
            label: "API",
            position: "left",
          },
          {
            href: "https://github.com/fengjutian/WeiSQL",
            label: "GitHub",
            position: "right",
          },
        ],
      },
      announcementBar: {
        id: "pre-release",
        content:
          'WeiSQL AI 0.1.0 · 工程原型，尚未发布 npm。<a href="/docs/reference/limitations">查看当前限制</a>',
        backgroundColor: "#0f766e",
        textColor: "#ffffff",
        isCloseable: true,
      },
      footer: {
        style: "dark",
        links: [
          {
            title: "文档",
            items: [
              { label: "文档首页", to: "/docs" },
              { label: "快速开始", to: "/docs/start/quickstart" },
              { label: "端到端教程", to: "/docs/start/tutorial" },
              { label: "API 参考", to: "/docs/api" },
              { label: "示例", to: "/docs/examples" },
              { label: "已知限制", to: "/docs/reference/limitations" },
            ],
          },
          {
            title: "项目",
            items: [
              {
                label: "GitHub 仓库",
                href: "https://github.com/fengjutian/WeiSQL",
              },
              {
                label: "规范与 ADR",
                href: "https://github.com/fengjutian/WeiSQL/tree/main/docs",
              },
              {
                label: "变更日志",
                href: "https://github.com/fengjutian/WeiSQL/blob/main/CHANGELOG.md",
              },
            ],
          },
          {
            title: "相关",
            items: [
              { label: "DuckDB", href: "https://duckdb.org/" },
              { label: "USearch", href: "https://github.com/unum-cloud/usearch" },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} WeiSQL AI · Apache-2.0`,
      },
      prism: {
        theme: themes.vsDark,
        darkTheme: themes.vsDark,
        additionalLanguages: ["bash", "json"],
      },
      docs: {
        sidebar: {
          hideable: true,
          autoCollapseCategories: false,
        },
      },
      tableOfContents: {
        minHeadingLevel: 2,
        maxHeadingLevel: 3,
      },
    }),
};

module.exports = config;
