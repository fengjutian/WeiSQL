/**
 * Runs the bundled-WASM vector scenario in Node, without a browser.
 *
 *   node tools/browser-probe/check-wasm-vector-scenario.mjs
 *
 * The browser page imports the same scenario, so this check exercises the parts
 * that do not need a DOM: fetching the packaged `.wasm` files over HTTP with the
 * probe server's MIME types, `HttpResourceReader` range requests against the
 * example package, and all three adapters. The browser job adds the real module
 * loading and `wasmArtifactUrl()` resolution on top.
 */
import { fileURLToPath, pathToFileURL } from "node:url";

import { WASM_ARTIFACTS } from "../../packages/sdk/dist/index.js";
import { createProbeServer } from "./server.mjs";
import { runWasmVectorScenario } from "./wasm-vector-scenario.mjs";

const sdkBase = pathToFileURL(fileURLToPath(new URL("../../packages/sdk/dist", import.meta.url))).href;

const probe = createProbeServer();
const port = await probe.listen();
const origin = `http://127.0.0.1:${port}`;

let result;
let failure;
try {
  result = await runWasmVectorScenario({
    sdkBase,
    fixtureBase: `${origin}/fixture/`,
    artifactUrl: name => new URL(`/wasm/${WASM_ARTIFACTS[name]}`, `${origin}/`),
    requireCleanGlobals: false,
  });
} catch (error) {
  failure = String(error && error.stack ? error.stack : error);
}

await probe.close();

if (failure !== undefined) {
  console.error(failure);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result?.ok === true ? 0 : 1;
}
