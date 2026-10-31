/**
 * Shared scenario for the bundled-WASM vector probe.
 *
 * Runs the same three-engine comparison in a browser page and in Node (see
 * `check-wasm-vector-scenario.mjs`), so the browser probe only adds the DOM
 * shell and the module-loading path on top of this logic.
 *
 *   runWasmVectorScenario({ sdkBase, fixtureBase })
 *
 * `sdkBase` points at the built SDK directory (`/sdk` in the probe server,
 * absolute when called from Node) and `fixtureBase` at a package directory.
 */

export async function runWasmVectorScenario({ sdkBase, fixtureBase, requireCleanGlobals = true }) {
  const started = typeof performance === "undefined" ? 0 : performance.now();
  const sdk = await import(`${sdkBase}/index.js`);
  const { HttpResourceReader } = await import(`${sdkBase}/http-resource-reader.js`);

  const manifest = JSON.parse(await (await fetch(new URL("manifest.json", fixtureBase))).text());
  const collection = manifest.vectorCollections[0];
  if (collection === undefined) throw new Error("fixture has no vector collection");
  const query = new Float32Array([1, 0]);
  const topK = Math.min(3, collection.count);

  const exactResponse = await fetch(sdk.wasmArtifactUrl("exact"));
  if (!exactResponse.ok) throw new Error(`exact wasm ${exactResponse.status}`);
  const contentType = exactResponse.headers.get("content-type") ?? "";
  if (!contentType.includes("application/wasm")) {
    throw new Error(`exact wasm content-type: ${contentType}`);
  }
  const exactBytes = await exactResponse.arrayBuffer();

  const hnswResponse = await fetch(sdk.wasmArtifactUrl("hnsw"));
  if (!hnswResponse.ok) throw new Error(`hnsw wasm ${hnswResponse.status}`);
  const hnswBytes = await hnswResponse.arrayBuffer();

  const reader = new HttpResourceReader({ baseUrl: fixtureBase });
  const reference = sdk.createExactVectorAdapter();
  const exactWasm = await sdk.createWasmVectorAdapter({ module: exactBytes });
  const hnsw = await sdk.createHnswWasmVectorAdapter({ module: hnswBytes });

  await reference.open({ manifest, reader });
  await exactWasm.open({ manifest, reader });
  await hnsw.open({ manifest, reader });

  const request = { vector: collection, query, topK };
  const expected = await reference.search(request);
  const exact = await exactWasm.search(request);
  const approximate = await hnsw.search(request);

  const signature = hits => hits.map(hit => `${hit.row}:${hit.id}`).join(",");
  const distances = hits => hits.map(hit => Number(hit.distance.toFixed(9)));
  const expectedDistances = distances(expected);
  const exactDistances = distances(exact);
  const closeEnough = expectedDistances.every(
    (value, index) => Math.abs(value - exactDistances[index]) < 1e-9,
  );

  const cleanGlobals = typeof process === "undefined" && typeof Buffer === "undefined";
  const result = {
    ok:
      signature(expected) === signature(exact) &&
      closeEnough &&
      signature(exact) === signature(approximate) &&
      hnsw.capabilities.exactSearch === false &&
      exactWasm.capabilities.exactSearch === true &&
      approximate[0]?.diagnostics.backend === "rust-hnsw-wasm" &&
      exact[0]?.diagnostics.backend === "rust-wasm-exact" &&
      (!requireCleanGlobals || cleanGlobals),
    cleanGlobals,
    expected: signature(expected),
    exactWasm: signature(exact),
    hnswWasm: signature(approximate),
    distances: { expected: expectedDistances, hnsw: distances(approximate) },
    backends: { exact: exact[0]?.diagnostics.backend, hnsw: approximate[0]?.diagnostics.backend },
    artifacts: { exactBytes: exactBytes.byteLength, hnswBytes: hnswBytes.byteLength },
    elapsedMs: Math.round((typeof performance === "undefined" ? 0 : performance.now()) - started),
  };

  await reference.close();
  await exactWasm.close();
  await hnsw.close();
  return result;
}
