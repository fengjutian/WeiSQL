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
          routeBasePath: "/",
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
        docsRouteBasePath: "/",
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
      image: "img/logo.svg",
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
            to: "/start/quickstart",
            label: "快速开始",
            position: "left",
          },
          {
            href: "https://github.com/fengjutian/WeiSQL",
            label: "GitHub",
            position: "right",
          },
        ],
      },
      footer: {
        style: "dark",
        links: [
          {
            title: "文档",
            items: [
              { label: "快速开始", to: "/start/quickstart" },
              { label: "核心概念", to: "/start/concepts" },
              { label: "SDK 使用", to: "/sdk/open-and-lifecycle" },
              { label: "已知限制", to: "/reference/limitations" },
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
        theme: themes.github,
        darkTheme: themes.dracula,
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
