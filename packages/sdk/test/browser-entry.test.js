import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");

/**
 * Walks the static import graph of the browser entry and fails on any `node:`
 * specifier. Without this, adding a Node-only re-export to `index.ts` silently
 * breaks every browser bundler with errors like `"realpath" is not exported by
 * "__vite-browser-external"`.
 */
test("browser entry does not import node: builtins", async () => {
  const pending = [path.join(DIST, "index.js")];
  const seen = new Set();
  const offenders = [];

  while (pending.length > 0) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);

    const source = await readFile(file, "utf8");
    for (const match of source.matchAll(/from\s+"([^"]+)"/g)) {
      const specifier = match[1];
      if (specifier.startsWith("node:")) {
        offenders.push(`${path.relative(DIST, file)} -> ${specifier}`);
      } else if (specifier.startsWith(".")) {
        pending.push(path.resolve(path.dirname(file), specifier));
      }
    }
  }

  assert.deepEqual(offenders, [], "browser entry reaches Node builtins");
});

test("node-only symbols live in the node entry only", async () => {
  const browser = await import("../dist/index.js");
  const node = await import("../dist/index.node.js");

  assert.equal("NodeFileResourceReader" in browser, false);
  assert.equal("buildPackage" in browser, false);
  assert.equal(typeof node.NodeFileResourceReader, "function");
  assert.equal(typeof node.buildPackage, "function");
  assert.equal(typeof node.open, "function");
});
