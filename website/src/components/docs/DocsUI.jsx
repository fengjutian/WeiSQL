import React from "react";
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
