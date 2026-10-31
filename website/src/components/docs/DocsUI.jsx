import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "@docusaurus/Link";
import styles from "./docs-ui.module.css";

export function PageHero({ kicker, title, lead, chips = [] }) {
  return (
    <header className={styles.hero}>
      <span className={styles.heroGlow} aria-hidden="true" />
      {kicker ? <span className={styles.kicker}>{kicker}</span> : null}
      <h1 className={styles.heroTitle}>{title}</h1>
      {lead ? <p className={styles.heroLead}>{lead}</p> : null}
      {chips.length > 0 ? (
        <ul className={styles.chips}>
          {chips.map((chip) => (
            <li key={chip}>{chip}</li>
          ))}
        </ul>
      ) : null}
    </header>
  );
}

export function CardGrid({ columns = 2, children }) {
  return (
    <div className={styles.grid} data-columns={columns}>
      {children}
    </div>
  );
}

export function DocCard({ index, title, to, tag, children }) {
  const content = (
    <>
      <div className={styles.cardTop}>
        {index ? <span className={styles.cardIndex}>{index}</span> : null}
        {tag ? <span className={styles.cardTag}>{tag}</span> : null}
      </div>
      <h3 className={styles.cardTitle}>{title}</h3>
      <div className={styles.cardBody}>{children}</div>
      {to ? <span className={styles.cardMore}>了解 →</span> : null}
    </>
  );

  return to ? (
    <Link className={styles.card} to={to}>
      {content}
    </Link>
  ) : (
    <div className={styles.card}>{content}</div>
  );
}

export function LayerStack({ layers }) {
  return (
    <ol className={styles.layers}>
      {layers.map((layer, index) => (
        <li className={styles.layer} key={layer.title}>
          <span className={styles.layerIndex}>
            {String(index + 1).padStart(2, "0")}
          </span>
          <div className={styles.layerMain}>
            <div className={styles.layerHead}>
              <h3>{layer.title}</h3>
              {layer.tag ? <span className={styles.layerTag}>{layer.tag}</span> : null}
            </div>
            <p>{layer.desc}</p>
            {layer.tags?.length ? (
              <ul className={styles.layerTags}>
                {layer.tags.map((tag) => (
                  <li key={tag}>{tag}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function FlowSteps({ steps, columns = 3 }) {
  return (
    <ol className={styles.flow} data-columns={columns}>
      {steps.map((step, index) => (
        <li className={styles.flowStep} key={step.title}>
          <span className={styles.flowNumber}>{index + 1}</span>
          <h3>{step.title}</h3>
          <p>{step.desc}</p>
          {step.code ? (
            <code className={styles.flowCode}>{step.code}</code>
          ) : null}
        </li>
      ))}
    </ol>
  );
}

export function Callout({ tone = "teal", title, children }) {
  return (
    <aside className={styles.callout} data-tone={tone}>
      {title ? <strong>{title}</strong> : null}
      <div>{children}</div>
    </aside>
  );
}

export function Module({ children }) {
  return <section className={styles.module}>{children}</section>;
}

export function ExampleLinks({ items = [] }) {
  const labels = {
    node: "Node.js 示例",
    browser: "浏览器示例",
    build: "构建与发布示例",
  };
  return (
    <nav className={styles.exampleBar} aria-label="相关示例">
      <span>可复制示例</span>
      {items.map((item) => (
        <Link key={item} to={`/docs/examples/${item}`}>
          {labels[item] ?? item}
        </Link>
      ))}
    </nav>
  );
}

export function ZoomImage({ src, alt, caption }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    const previous = document.body.style.overflow;
    const onKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previous;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <figure className={styles.zoomFigure}>
      <button
        type="button"
        className={styles.zoomButton}
        onClick={() => setOpen(true)}
        aria-label={`放大图片：${alt}`}
      >
        <img src={src} alt={alt} loading="lazy" />
      </button>
      {caption ? <figcaption>{caption}</figcaption> : null}
      {open && mounted
        ? createPortal(
            <div
              className={styles.lightbox}
              role="dialog"
              aria-modal="true"
              aria-label={alt}
              onClick={() => setOpen(false)}
            >
              <img
                src={src}
                alt={alt}
                onClick={(event) => event.stopPropagation()}
              />
              <button
                type="button"
                className={styles.lightboxClose}
                onClick={() => setOpen(false)}
                aria-label="关闭大图"
              >
                ×
              </button>
            </div>,
            document.body,
          )
        : null}
    </figure>
  );
}
