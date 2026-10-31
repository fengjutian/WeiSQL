import React from "react";
import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
import CodeBlock from "@theme/CodeBlock";
import styles from "./index.module.css";

const features = [
  {
    index: "01",
    title: "精确向量检索",
    body: "Cosine / L2 / IP 统一为“越小越相似”，Float32 分块读取，Top-K 结果可声明 exact。",
    to: "/docs/sdk/vector-search",
  },
  {
    index: "02",
    title: "过滤先于 Top-K",
    body: "exact-filter-first 先用 SQL 求出允许行，再在子集上比较，结果仍是严格最近 K。",
    to: "/docs/sdk/vector-search",
  },
  {
    index: "03",
    title: "全文与 RRF 融合",
    body: "BM25 关键词检索与向量结果按名次融合，不依赖分数归一化，也不调用外部服务。",
    to: "/docs/sdk/text-and-hybrid",
  },
  {
    index: "04",
    title: "RAG 证据组装",
    body: "在字符预算内返回带来源与名次的片段，截断落在句末或词边界；模型与 prompt 由应用负责。",
    to: "/docs/sdk/rag",
  },
  {
    index: "05",
    title: "只读 SQL",
    body: "DuckDB 与 DuckDB-Wasm 通过 Adapter 注入，参数绑定、语句级只读边界、可取消。",
    to: "/docs/sdk/sql",
  },
  {
    index: "06",
    title: "单文件与签名",
    body: ".wsql 把数据包合成一个对象；Ed25519 签名与 L3 摘要分别证明来源与内容一致。",
    to: "/docs/sdk/containers",
  },
];

const steps = [
  {
    number: "01",
    title: "构建不可变数据包",
    body: "从已有 Parquet、向量与业务 ID 生成 Manifest、ID Map 与真实摘要，发布前完成 L1–L3 自检。",
    code: `const report = await buildPackage({\n  outputDirectory: "dist/demo",\n  datasetId: "demo-documents",\n  tables, vectorCollections,\n});`,
  },
  {
    number: "02",
    title: "发布到静态托管",
    body: "目录或单个 .wsql 上传到 CDN / Netlify；按 Range 读取，不需要数据库进程或查询服务。",
    code: `# 发布前校验\nnpx weisql validate ./dist/demo --l4\n\n# 单文件\nnpx weisql pack ./dist/demo --compress`,
  },
  {
    number: "03",
    title: "在端上查询",
    body: "浏览器与 Node.js 共用同一套 Runtime：向量、全文、RRF、RAG、SQL 都是只读调用。",
    code: `const db = await open({\n  manifestUrl: "/demo/manifest.json",\n  resourceReader: new HttpResourceReader({\n    baseUrl: "/demo/",\n  }),\n});`,
  },
];

const apis = [
  {
    signature: "open(options)",
    label: "创建只读 Runtime",
    to: "/docs/api/runtime",
  },
  {
    signature: "db.vector.search(name, vector, options?)",
    label: "精确 / 过滤向量检索",
    to: "/docs/api/search",
  },
  {
    signature: "db.text.search(name, query, options?)",
    label: "BM25 全文检索",
    to: "/docs/api/search",
  },
  {
    signature: "db.hybrid.search(options)",
    label: "RRF 融合两路结果",
    to: "/docs/api/search",
  },
  {
    signature: "db.rag.search(options)",
    label: "按字符预算组装证据",
    to: "/docs/api/search",
  },
  {
    signature: "db.sql(query, params?, options?)",
    label: "只读 SQL",
    to: "/docs/api/sql",
  },
  {
    signature: "db.sqlStream(query, params?, options?)",
    label: "流式读取 SQL 结果",
    to: "/docs/api/sql",
  },
  {
    signature: "db.close()",
    label: "幂等释放资源",
    to: "/docs/api/runtime",
  },
];

const heroCode = `import {
  open,
  HttpResourceReader,
} from "@weisql/sdk";

const db = await open({
  manifestUrl: "/datasets/demo/manifest.json",
  resourceReader: new HttpResourceReader({
    baseUrl: "/datasets/demo/",
  }),
  verifyChecksums: "all",
});

const hits = await db.vector.search(
  "document_embeddings",
  queryVector,
  {
    topK: 10,
    filter: { category: "genetics" },
  },
);`;

function HeroCode() {
  return (
    <div className={styles.codeCard}>
      <div className={styles.codeBar}>
        <span className={styles.dot} />
        <span className={styles.dot} />
        <span className={styles.dot} />
        <span className={styles.codeName}>app.ts</span>
      </div>
      <CodeBlock language="ts" className={styles.codeBlock}>
        {heroCode}
      </CodeBlock>
      <div className={styles.codeFooter}>
        <span className={styles.pulse} />
        exact: true · diagnostics.exact
      </div>
    </div>
  );
}

export default function Home() {
  return (
    <Layout
      title="只读数据运行时"
      description="WeiSQL AI 把 Parquet、向量与全文索引打包成静态数据包，在浏览器与 Node.js 中按需查询，无需数据库服务。"
    >
      <main className={styles.page}>
        <section className={styles.hero}>
          <div className={styles.heroInner}>
            <div className={styles.heroCopy}>
              <span className={styles.eyebrow}>
                <span className={styles.eyebrowDot} />
                WeiSQL AI · 只读数据运行时
              </span>
              <h1 className={styles.title}>
                把数据包放上 CDN
                <br />
                <span className={styles.gradient}>像数据库一样查询</span>
              </h1>
              <p className={styles.lead}>
                Parquet、Float32 向量与全文索引打包成不可变快照。浏览器和
                Node.js 按需读取，没有服务端、没有连接、没有写入路径。
              </p>
              <div className={styles.actions}>
                <Link className={styles.primary} to="/docs/start/quickstart">
                  5 分钟快速开始
                  <span aria-hidden="true">→</span>
                </Link>
                <Link className={styles.ghost} to="/docs/start/architecture">
                  看架构
                </Link>
                <Link className={styles.textLink} to="/docs/start/tutorial">
                  端到端教程
                </Link>
                <a
                  className={styles.textLink}
                  href="https://github.com/fengjutian/WeiSQL"
                  target="_blank"
                  rel="noreferrer"
                >
                  GitHub ↗
                </a>
              </div>
              <dl className={styles.stats}>
                <div>
                  <dt>321</dt>
                  <dd>自动化测试</dd>
                </div>
                <div>
                  <dt>0</dt>
                  <dd>SDK 运行时依赖</dd>
                </div>
                <div>
                  <dt>1.0.0</dt>
                  <dd>Manifest 格式</dd>
                </div>
              </dl>
            </div>
            <div className={styles.heroVisual}>
              <div className={styles.glow} />
              <HeroCode />
              <div className={styles.floatingCard}>
                <span className={styles.floatingLabel}>Range 读取</span>
                <strong>206 Partial Content</strong>
                <span className={styles.floatingMeta}>
                  只取需要的向量块
                </span>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHead}>
            <span className={styles.kicker}>能力</span>
            <h2>一个 Runtime，覆盖检索到证据</h2>
            <p>
              引擎通过 Adapter 注入，SDK 本身零引擎依赖。缺能力时明确失败，
              不返回模拟数据。
            </p>
          </div>
          <div className={styles.grid}>
            {features.map((feature) => (
              <Link className={styles.card} to={feature.to} key={feature.index}>
                <span className={styles.cardIndex}>{feature.index}</span>
                <h3>{feature.title}</h3>
                <p>{feature.body}</p>
                <span className={styles.cardMore}>了解 →</span>
              </Link>
            ))}
          </div>
        </section>

        <section className={styles.apiSection}>
          <div className={styles.apiPanel}>
            <div className={styles.apiHead}>
              <div>
                <span className={styles.kicker}>API</span>
                <h2>公开 API，一眼能查</h2>
                <p>
                  从 <code>open()</code> 到向量、全文、RAG 与 SQL，每个签名都有独立的参考页。
                </p>
              </div>
              <Link className={styles.ghost} to="/docs/api">
                完整 API 参考
              </Link>
            </div>
            <div className={styles.apiGrid}>
              {apis.map((api) => (
                <Link className={styles.apiRow} to={api.to} key={api.signature}>
                  <code>{api.signature}</code>
                  <span>{api.label}</span>
                </Link>
              ))}
            </div>
          </div>
        </section>

        <section className={styles.stepsSection}>
          <div className={styles.sectionHead}>
            <span className={styles.kicker}>工作方式</span>
            <h2>构建一次，按需读取</h2>
            <p>数据是构建产物，查询发生在客户端；更新等于发布一份新快照。</p>
          </div>
          <div className={styles.steps}>
            {steps.map((step) => (
              <div className={styles.step} key={step.number}>
                <div className={styles.stepHead}>
                  <span className={styles.stepNumber}>{step.number}</span>
                  <h3>{step.title}</h3>
                </div>
                <p>{step.body}</p>
                <pre className={styles.stepCode}>
                  <code>{step.code}</code>
                </pre>
              </div>
            ))}
          </div>
        </section>

        <section className={styles.boundary}>
          <div className={styles.boundaryInner}>
            <div>
              <span className={styles.kicker}>边界</span>
              <h2>
                只读、<span className={styles.nowrap}>无服务端</span>、默认公开
              </h2>
              <p>
                精确检索、全文、RRF、RAG、容器与签名已经可用；ANN
                召回、真实 CDN 性能与浏览器大表仍是未验证项，不要写进对外承诺。
              </p>
            </div>
            <Link className={styles.ghost} to="/docs/reference/limitations">
              查看已知限制
            </Link>
          </div>
        </section>

        <section className={styles.cta}>
          <div className={styles.ctaInner}>
            <h2>用 3 条记录跑通第一条查询</h2>
            <p>
              仓库自带可校验的 fixture。安装、构建、检索、校验，一条命令链走完。
            </p>
            <div className={styles.actions}>
              <Link className={styles.primary} to="/docs/start/quickstart">
                开始
                <span aria-hidden="true">→</span>
              </Link>
              <Link className={styles.ghost} to="/docs/reference/capabilities">
                能力矩阵
              </Link>
            </div>
          </div>
        </section>
      </main>
    </Layout>
  );
}
