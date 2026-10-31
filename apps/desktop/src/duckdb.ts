import type { SqlAdapter } from "@weisql/sdk";

/** Absolute URL for an asset shipped in `public/` (works under Vite and Tauri). */
export function assetUrl(relative: string): string {
  return new URL(relative, document.baseURI).href;
}

/**
 * The DuckDB-Wasm adapter is imported lazily: the 34 MB WASM bundle and the
 * parquet extension are only downloaded when the user actually runs SQL or asks
 * for a filtered vector search.
 */
export async function createSqlAdapter(): Promise<SqlAdapter> {
  const { createDuckDbWasmAdapter } = await import("@weisql/duckdb-wasm-adapter");
  return createDuckDbWasmAdapter({
    bundles: {
      mainModule: assetUrl("duckdb/duckdb-eh.wasm"),
      mainWorker: assetUrl("duckdb/duckdb-browser-eh.worker.js"),
    },
    // The parquet extension is served from the app itself; extensions.duckdb.org
    // sends no CORS headers, so a cross-origin download cannot work.
    extensionRepository: assetUrl("extensions"),
    logger: "silent",
  });
}
