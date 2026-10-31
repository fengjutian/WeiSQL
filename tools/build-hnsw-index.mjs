#!/usr/bin/env node
/**
 * Compatibility wrapper for the HNSW half of the unified ANN index builder.
 *
 *   node tools/build-hnsw-index.mjs <package-dir> [options]
 *
 * Prefer `node tools/build-ann-index.mjs <package-dir> --engine hnsw` for new
 * scripts; this entry point keeps the existing `npm run build:hnsw-index` and
 * `test:hnsw-package` commands working with the same implementation.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const TOOL = fileURLToPath(new URL("./build-ann-index.mjs", import.meta.url));
const result = spawnSync(process.execPath, [TOOL, ...process.argv.slice(2), "--engine", "hnsw"], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
