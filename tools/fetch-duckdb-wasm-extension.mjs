/**
 * Downloads the DuckDB `parquet` extension that matches the bundled WASM core.
 *
 *   node tools/fetch-duckdb-wasm-extension.mjs
 *
 * Why this exists: extensions.duckdb.org does not send CORS headers, so a
 * browser page cannot fetch the extension cross-origin (`XMLHttpRequest` fails,
 * see ADR-044). Serving it from the same origin as the data package fixes that
 * without giving up DuckDB-Wasm's parquet support.
 *
 * The extension version must match the DuckDB core compiled into the WASM
 * module, so the version is read from the module itself instead of being
 * hard-coded. Files land in `.cache/duckdb-wasm-extensions/<version>/<platform>/`
 * and are git-ignored; nothing here is part of a published package.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDuckDB, NODE_RUNTIME, VoidLogger } from "@duckdb/duckdb-wasm/blocking";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
export const EXTENSION_CACHE = path.join(REPO_ROOT, ".cache", "duckdb-wasm-extensions");
const REGISTRY = "https://extensions.duckdb.org";
const PLATFORMS = ["wasm_eh", "wasm_mvp"];

/** Reads the DuckDB core version compiled into the WASM module. */
async function readCoreVersion() {
  const dist = path.join(REPO_ROOT, "node_modules", "@duckdb", "duckdb-wasm", "dist");
  const bindings = await createDuckDB(
    {
      mvp: { mainModule: path.join(dist, "duckdb-mvp.wasm"), mainWorker: null },
      eh: { mainModule: path.join(dist, "duckdb-eh.wasm"), mainWorker: null },
    },
    new VoidLogger(),
    NODE_RUNTIME,
  );
  await bindings.instantiate();
  return bindings.getVersion();
}

export function extensionPath(version, platform) {
  return path.join(EXTENSION_CACHE, version, platform, "parquet.duckdb_extension.wasm");
}

/**
 * Ensures the extension for `platform` is cached, downloading it if needed.
 * Returns the absolute path.
 */
export async function ensureParquetExtension(platform = "wasm_eh", version = undefined) {
  const resolvedVersion = version ?? (await readCoreVersion());
  const target = extensionPath(resolvedVersion, platform);
  if (existsSync(target)) return target;

  const url = `${REGISTRY}/${resolvedVersion}/${platform}/parquet.duckdb_extension.wasm`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to download ${url}: HTTP ${response.status}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength < 8 || bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) {
    throw new Error(`${url} did not return a WebAssembly module`);
  }
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return target;
}

export function digestOf(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = await readCoreVersion();
  for (const platform of PLATFORMS) {
    const file = await ensureParquetExtension(platform, version);
    const bytes = await readFile(file);
    console.log(`${version}/${platform}: ${path.relative(REPO_ROOT, file)} (${bytes.byteLength} bytes, sha256 ${digestOf(bytes)})`);
  }
}
