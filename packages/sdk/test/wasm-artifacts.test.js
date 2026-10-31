import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { WASM_ARTIFACTS, wasmArtifactsManifestUrl, wasmArtifactUrl } from "../dist/index.js";

test("ships both WASM vector artifacts in the package", async () => {
  for (const [name, file] of Object.entries(WASM_ARTIFACTS)) {
    const url = wasmArtifactUrl(name);
    assert.equal(url.pathname.endsWith(`/wasm/${file}`), true, `${name} should resolve inside wasm/`);
    const bytes = await readFile(url);
    assert.ok(bytes.byteLength > 1000, `${name} should not be empty`);
    // A wasm module starts with the \0asm magic.
    assert.deepEqual([...bytes.subarray(0, 4)], [0x00, 0x61, 0x73, 0x6d]);
  }
});

test("artifact manifest records the shipped bytes", async () => {
  const manifest = JSON.parse(await readFile(wasmArtifactsManifestUrl(), "utf8"));
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.artifacts.length, Object.keys(WASM_ARTIFACTS).length);
  for (const record of manifest.artifacts) {
    const bytes = await readFile(wasmArtifactUrl(record.name === WASM_ARTIFACTS.exact ? "exact" : "hnsw"));
    assert.equal(bytes.byteLength, record.bytes, `${record.name} size`);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), record.sha256, `${record.name} digest`);
    assert.ok(record.abiVersion > 0);
  }
});
