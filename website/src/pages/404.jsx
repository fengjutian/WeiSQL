import React from "react";
import Layout from "@theme/Layout";
import Link from "@docusaurus/Link";
import styles from "./404.module.css";

export default function NotFound() {
  return (
    <Layout title="页面不存在" description="请求的页面不存在。">
      <main className={styles.page}>
        <div className={styles.card}>
          <span className={styles.code}>404 / NOT FOUND</span>
          <h1 className={styles.title}>这个数据包没有这个文件</h1>
          <p className={styles.lead}>
            链接可能已经随架构、API 分区调整而变化。可以回到首页，或直接搜索。
          </p>
          <div className={styles.actions}>
            <Link className={styles.primary} to="/">
              返回首页
            </Link>
            <Link className={styles.ghost} to="/docs/start/quickstart">
              快速开始
            </Link>
            <Link className={styles.ghost} to="/docs">
              文档
            </Link>
          </div>
          <p className={styles.hint}>
            按 <kbd>Ctrl</kbd> + <kbd>K</kbd> 打开搜索
          </p>
        </div>
      </main>
    </Layout>
  );
}
