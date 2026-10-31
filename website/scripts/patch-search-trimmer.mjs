/**
 * 修复 @easyops-cn/docusaurus-search-local 的中英混排检索。
 *
 * 插件的 zh 分词器会把词项交给 lunr.zh.trimmer，而该 trimmer 只保留汉字，
 * 导致 SQL、CTE、DuckDB、BM25 这类英文技术词在索引与查询时都被裁掉。
 * 这里把 A-Za-z0-9_ 加入允许字符集，中文分词逻辑保持不变。
 *
 * 该脚本在 postinstall 中运行；已修补时直接跳过，找不到预期文本则失败，
 * 避免插件升级后静默失效。
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targets = [
  "node_modules/@easyops-cn/docusaurus-search-local/dist/server/shared/lunrLanguageZh.js",
  "node_modules/@easyops-cn/docusaurus-search-local/dist/client/shared/lunrLanguageZh.js",
];

const NEEDLE = String.raw`\\u{3134A}";`;
const REPLACED = String.raw`\\u{3134A}A-Za-z0-9_";`;

let changed = 0;
for (const relative of targets) {
  const file = path.join(root, relative);
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      throw new Error(
        `[search-trimmer] 找不到 ${relative}。插件版本可能已变化，请重新核对补丁逻辑。`,
      );
    }
    throw error;
  }
  if (source.includes(REPLACED)) continue;
  if (!source.includes(NEEDLE)) {
    throw new Error(
      `[search-trimmer] ${relative} 中未找到预期字符集，插件可能已升级；请核对后更新脚本。`,
    );
  }
  await writeFile(file, source.replace(NEEDLE, REPLACED), "utf8");
  changed += 1;
}

console.log(
  changed === 0
    ? "[search-trimmer] 已是修补状态，跳过。"
    : `[search-trimmer] 已修补 ${changed} 个文件，英文技术词可被检索。`,
);
