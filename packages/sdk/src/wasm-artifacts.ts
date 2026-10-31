/**
 * Locations of the WASM artifacts shipped inside `@weisql/sdk`.
 *
 * Consumers do not need a Rust toolchain: `wasm/` contains the exact bytes
 * that were tested, and `wasm/artifacts.json` records their sizes, SHA-256
 * digests and ABI versions. `wasmArtifactUrl()` works in Node.js
 * (`readFile(url)`) and in browsers (`fetch(url)`).
 *
 * `tools/embed-wasm.mjs` refreshes the files; `npm run release:check` refuses a
 * package whose bytes and manifest disagree.
 */

/** `exact` is the brute-force cosine/L2/IP scanner; `hnsw` is the approximate graph. */
export type WasmArtifactName = "exact" | "hnsw";

export const WASM_ARTIFACTS: Readonly<Record<WasmArtifactName, string>> = Object.freeze({
  exact: "weisql_vector_wasm.wasm",
  hnsw: "weisql_vector_hnsw_wasm.wasm",
});

/** URL of the requested module, `.../@weisql/sdk/wasm/<file>`. */
export function wasmArtifactUrl(name: WasmArtifactName): URL {
  const file = WASM_ARTIFACTS[name];
  if (file === undefined) {
    throw new TypeError(`Unknown WASM artifact '${String(name)}'; expected 'exact' or 'hnsw'`);
  }
  return new URL(`../wasm/${file}`, import.meta.url);
}

/** URL of the generated manifest that records sizes, digests and ABI versions. */
export function wasmArtifactsManifestUrl(): URL {
  return new URL("../wasm/artifacts.json", import.meta.url);
}
