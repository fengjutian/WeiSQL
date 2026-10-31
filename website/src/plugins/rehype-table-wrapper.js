/**
 * Wrap every Markdown table in a scroll container.
 *
 * Docusaurus renders tables directly inside `.theme-doc-markdown`, so a wide
 * table either squeezes its columns on mobile or overflows the page. A wrapper
 * lets CSS give small screens a horizontal scroll area without changing the
 * table markup on desktop.
 */
module.exports = function rehypeTableWrapper() {
  return (tree) => {
    const walk = (node) => {
      if (!Array.isArray(node.children)) return;
      node.children = node.children.map((child) => {
        walk(child);
        if (child.type === "element" && child.tagName === "table") {
          return {
            type: "element",
            tagName: "div",
            properties: { className: ["table-scroll"] },
            children: [child],
          };
        }
        return child;
      });
    };
    walk(tree);
  };
};
