import React from "react";
import Content from "@theme-original/DocItem/Content";
import { useDoc } from "@docusaurus/plugin-content-docs/client";
import { PageHero, ExampleLinks } from "@site/src/components/docs/DocsUI";

/**
 * Optional per-page hero.
 *
 * Pages opt in with frontmatter:
 *
 *   hero:
 *     kicker: SDK
 *     title: ...
 *     lead: ...
 *     chips: ["Node.js", "Browser"]
 *   hide_title: true
 *   examples: [node, browser]
 *
 * Pages that already render <PageHero> in MDX simply omit `hero`.
 */
export default function DocItemContent(props) {
  const { metadata } = useDoc();
  const hero = metadata.frontMatter?.hero;
  const examples = metadata.frontMatter?.examples;

  return (
    <>
      {hero ? (
        <PageHero
          kicker={hero.kicker}
          title={hero.title}
          lead={hero.lead}
          chips={hero.chips ?? []}
        />
      ) : null}
      {Array.isArray(examples) && examples.length > 0 ? (
        <ExampleLinks items={examples} />
      ) : null}
      <Content {...props} />
    </>
  );
}
