import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { validateManifest } from "../dist/index.js";

async function baseManifest() {
  return JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
}

function withIndex(manifest, index) {
  manifest.vectorCollections[0].index = index;
  return manifest;
}

const INDEX_FILE = { path: "indexes/embeddings.usearch", bytes: 128, sha256: "a".repeat(64) };

test("accepts engine-specific index parameters", async () => {
  const manifest = withIndex(await baseManifest(), {
    engine: "usearch",
    version: "2.26.5",
    file: INDEX_FILE,
    params: { connectivity: 16, expansion_add: 128, expansion_search: 512 },
  });
  const parsed = validateManifest(manifest);
  assert.deepEqual(parsed.vectorCollections[0].index?.params, { connectivity: 16, expansion_add: 128, expansion_search: 512 });
});

test("accepts an index without parameters", async () => {
  const manifest = withIndex(await baseManifest(), { engine: "usearch", version: "2.26.5", file: INDEX_FILE });
  assert.equal(validateManifest(manifest).vectorCollections[0].index?.params, undefined);
});

test("rejects non-numeric or non-identifier index parameters", async () => {
  for (const params of [{ connectivity: "16" }, { connectivity: null }, { "bad key": 1 }]) {
    const manifest = withIndex(await baseManifest(), { engine: "usearch", version: "2.26.5", file: INDEX_FILE, params });
    assert.throws(() => validateManifest(manifest), { code: "MANIFEST_INVALID" }, JSON.stringify(params));
  }
});

test("rejects too many index parameters", async () => {
  const params = {};
  for (let index = 0; index < 33; index++) params[`p${index}`] = index;
  const manifest = withIndex(await baseManifest(), { engine: "usearch", version: "2.26.5", file: INDEX_FILE, params });
  assert.throws(() => validateManifest(manifest), { code: "MANIFEST_INVALID" });
});

test("index file still has to be a valid resource descriptor", async () => {
  const manifest = withIndex(await baseManifest(), { engine: "usearch", version: "2.26.5", file: { ...INDEX_FILE, sha256: "short" } });
  assert.throws(() => validateManifest(manifest), { code: "MANIFEST_INVALID" });
});
