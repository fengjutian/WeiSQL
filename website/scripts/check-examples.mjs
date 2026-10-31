import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "@babel/parser";

const root = path.resolve("content/examples");
const files = (await readdir(root))
  .filter((name) => name.endsWith(".md") || name.endsWith(".mdx"))
  .sort();

const fence = /```(ts|tsx|js|jsx)\n([\s\S]*?)```/g;
let checked = 0;
let skipped = 0;
const failures = [];

for (const name of files) {
  const text = await readFile(path.join(root, name), "utf8");
  const lines = text.split("\n");
  let match;
  while ((match = fence.exec(text)) !== null) {
    const [, lang, code] = match;
    const line = text.slice(0, match.index).split("\n").length;
    // Some snippets intentionally elide arguments with `{ ... }`.
    if (/\{\s*\.\.\.\s*\}/.test(code) || /^\s*\.\.\.\s*$/m.test(code)) {
      skipped += 1;
      continue;
    }
    try {
      parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx", "topLevelAwait"],
      });
      checked += 1;
    } catch (error) {
      failures.push({
        file: name,
        line,
        lang,
        message: error.message,
        code: lines.slice(line - 1, line + 2).join("\n"),
      });
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`\n${failure.file}:${failure.line} (${failure.lang})`);
    console.error(failure.message);
    console.error(failure.code);
  }
  console.error(`\n${failures.length} snippet(s) failed to parse.`);
  process.exit(1);
}

console.log(
  `Example snippets: ${checked} parsed, ${skipped} intentionally partial.`,
);
