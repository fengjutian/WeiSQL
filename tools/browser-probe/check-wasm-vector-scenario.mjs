/**
 * Runs the bundled-WASM vector scenario in Node, without a browser.
 *
 *   node tools/browser-probe/check-wasm-vector-scenario.mjs
 *
 * The browser probe adds only the DOM shell on top of this scenario; running the
 * same code here exercises the real HTTP fetch of the packaged `.wasm` files,
 * `HttpResourceReader` range requests and all three adapters, and it can run on
 * every CI job that has a built SDK.
 */
import { createProbeServer } from "./server.mjs";
import { runWasmVectorScenario } from "./wasm-vector-scenario.mjs";

const probe = createProbeServer();
const port = await probe.listen();
const origin = `http://127.0.0.1:${port}`;

let result;
let failure;
try {
  result = await runWasmVectorScenario({
    sdkBase: `${origin}/sdk`,
    fixtureBase: `${origin}/fixture/`,
    requireCleanGlobals: false,
  });
} catch (error) {
  failure = String(error && error.stack ? error.stack : error);
}

await probe.close();

if (failure !== undefined) {
  console.error(failure);
  process.exit(1);
}
console.log(JSON.stringify(result, null, 2));
process.exit(result?.ok === true ? 0 : 1);
