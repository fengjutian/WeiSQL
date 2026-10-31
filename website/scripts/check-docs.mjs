import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = path.resolve("content");
const files = [];

async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.name.endsWith(".md") || entry.name.endsWith(".mdx")) {
      files.push(full);
    }
  }
}

await walk(root);

const routeOf = (file) => {
  const rel = path
    .relative(root, file)
    .split(path.sep)
    .join("/")
    .replace(/\.mdx?$/, "");
  if (rel === "index") return "/docs";
  if (rel.endsWith("/index")) return `/docs/${rel.slice(0, -"/index".length)}`;
  return `/docs/${rel}`;
};

const routes = new Set(files.map(routeOf));
const problems = [];
let totalLines = 0;
let totalChars = 0;

const isAsset = (target) =>
  /\.(png|jpe?g|gif|svg|webp|pdf|zip|wsql)$/i.test(target);
const normalize = (value) =>
  value.split("#")[0].split("?")[0].replace(/\/$/, "") || "/";

for (const file of files) {
  const rel = path.relative(root, file).split(path.sep).join("/");
  const text = await readFile(file, "utf8");
  totalLines += text.split(/\r?\n/).length;
  totalChars += text.length;

  if (!text.startsWith("---\n")) {
    problems.push(`${rel}: missing frontmatter`);
  }
  const fmEnd = text.indexOf("\n---", 4);
  if (fmEnd === -1) problems.push(`${rel}: unclosed frontmatter`);
  const fm = fmEnd === -1 ? "" : text.slice(4, fmEnd);
  for (const key of ["title:", "description:", "sidebar_position:"]) {
    if (!fm.includes(key)) problems.push(`${rel}: frontmatter missing ${key}`);
  }

  const body = fmEnd === -1 ? text : text.slice(fmEnd + 4);
  let inFence = false;
  for (const line of body.split(/\r?\n/)) {
    if (line.startsWith("```")) {
      if (!inFence && !line.slice(3).trim()) {
        problems.push(`${rel}: code fence without language`);
      }
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^#\s/.test(line)) {
      problems.push(`${rel}: body H1: ${line}`);
    }
  }
  if (inFence) problems.push(`${rel}: unclosed code fence`);

  for (const match of body.matchAll(/\]\((\/[^)\s]*)\)/g)) {
    const target = normalize(match[1]);
    if (target === "/" || target === "/docs" || isAsset(target)) continue;
    if (!routes.has(target)) {
      problems.push(`${rel}: broken internal link ${match[1]}`);
    }
  }

  for (const match of body.matchAll(/(?:to|href)="(\/[^"]*)"/g)) {
    const target = normalize(match[1]);
    if (target === "/" || target === "/docs" || isAsset(target)) continue;
    if (!routes.has(target)) {
      problems.push(`${rel}: broken JSX link ${match[1]}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error(`\n${problems.length} docs problem(s).`);
  process.exit(1);
}

console.log(
  `Docs: ${files.length} files, ${totalLines} lines, ${totalChars} characters. No problems.`,
);
