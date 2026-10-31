/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docs: [
    { type: "link", label: "← 返回首页", href: "/" },
    { type: "doc", id: "index", label: "文档首页" },
    {
      type: "category",
      label: "开始",
      collapsed: false,
      items: [
        "start/what-is-weisql",
        "start/quickstart",
        "start/concepts",
        "start/architecture",
        "start/tech-stack",
      ],
    },
    {
      type: "category",
      label: "SDK 使用",
      collapsed: false,
      items: [
        "sdk/open-and-lifecycle",
        "sdk/resource-readers",
        "sdk/vector-search",
        "sdk/text-and-hybrid",
        "sdk/rag",
        "sdk/sql",
        "sdk/containers",
        "sdk/integrity-and-signing",
        "sdk/errors",
      ],
    },
    {
      type: "category",
      label: "适配器",
      collapsed: false,
      items: [
        "adapters/duckdb",
        "adapters/duckdb-wasm",
        "adapters/usearch",
      ],
    },
    {
      type: "category",
      label: "工具链",
      collapsed: false,
      items: [
        "tooling/cli",
        "tooling/build-package",
        "tooling/deploy-cdn",
        "tooling/benchmarks",
      ],
    },
    {
      type: "category",
      label: "参考",
      collapsed: false,
      items: [
        "reference/manifest",
        "reference/capabilities",
        "reference/compatibility",
        "reference/limitations",
        "reference/glossary",
      ],
    },
    {
      type: "category",
      label: "工程",
      collapsed: true,
      items: ["engineering/docs-framework-adr"],
    },
  ],
};

module.exports = sidebars;
