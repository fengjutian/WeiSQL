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
        { type: "doc", id: "start/tutorial", label: "端到端教程" },
        "start/concepts",
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
  architecture: [
    { type: "link", label: "← 返回文档", href: "/docs" },
    { type: "doc", id: "architecture/index", label: "架构总览" },
    { type: "doc", id: "architecture/query", label: "查询链路" },
    { type: "doc", id: "architecture/trust", label: "信任与部署" },
  ],
  api: [
    { type: "link", label: "← 返回文档", href: "/docs" },
    { type: "doc", id: "api/index", label: "API 总览" },
    { type: "doc", id: "api/runtime", label: "Runtime API" },
    { type: "doc", id: "api/readers", label: "Readers API" },
    { type: "doc", id: "api/search", label: "检索 API" },
    { type: "doc", id: "api/sql", label: "SQL API" },
    { type: "doc", id: "api/build-sign", label: "Builder 与签名 API" },
    { type: "doc", id: "api/adapters", label: "Adapter 工厂 API" },
  ],
};

module.exports = sidebars;
