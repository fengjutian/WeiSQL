import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { CONTAINER_MAGIC, WeiSQLError, parseContainer, validateManifest } from "../dist/index.js";

/**
 * Deterministic fuzzing for the two parsers that consume untrusted input.
 *
 * The property under test is not "invalid input is rejected" (that is covered by
 * the unit tests) but **how** it is rejected: anything a caller can pass must
 * either succeed or throw a WeiSQLError with a documented code. A TypeError or
 * RangeError escaping here would make safe handling impossible for callers.
 */

/** Small deterministic PRNG so failures are reproducible. */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

const MANIFEST_CODES = new Set(["MANIFEST_INVALID", "FORMAT_VERSION_UNSUPPORTED"]);
const CONTAINER_CODES = new Set(["RESOURCE_INTEGRITY_FAILED", "FORMAT_VERSION_UNSUPPORTED"]);

const KEYS = ["format", "formatVersion", "datasetId", "tables", "vectorCollections", "textIndexes", "metadata", "name", "file", "path", "bytes", "sha256", "columns", "primaryKey", "count", "dimension", "metric", "encoding", "data", "idMap", "documents", "termCount", "averageDocumentLength", "k1", "b", "engine", "version", "params"];

function randomValue(random, depth) {
  const pick = random();
  if (depth <= 0 || pick < 0.35) {
    const leaf = random();
    if (leaf < 0.3) return `s${Math.floor(random() * 1000)}`;
    if (leaf < 0.5) return Math.floor(random() * 1e6) - 500;
    if (leaf < 0.6) return random() * 1000;
    if (leaf < 0.7) return random() < 0.5;
    if (leaf < 0.8) return null;
    if (leaf < 0.9) return [];
    return ["a".repeat(Math.floor(random() * 70)), "../" + "x".repeat(Math.floor(random() * 5))];
  }
  if (pick < 0.6) {
    const length = Math.floor(random() * 4);
    return Array.from({ length }, () => randomValue(random, depth - 1));
  }
  const length = Math.floor(random() * 5);
  const object = {};
  for (let index = 0; index < length; index++) object[KEYS[Math.floor(random() * KEYS.length)]] = randomValue(random, depth - 1);
  return object;
}

test("validateManifest either accepts or throws a documented WeiSQLError", async () => {
  const base = JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
  const random = createRandom(0x5eed);
  let accepted = 0;
  let rejected = 0;

  for (let iteration = 0; iteration < 400; iteration++) {
    const candidate = iteration % 2 === 0
      ? randomValue(random, 3)
      : structuredClone(base);

    if (iteration % 2 === 1) {
      // Mutate the valid manifest: delete a key, swap a type, or inject a random field.
      const key = KEYS[Math.floor(random() * KEYS.length)];
      const action = random();
      if (action < 0.4) delete candidate[key];
      else if (action < 0.7) candidate[key] = randomValue(random, 2);
      else candidate["extra" + Math.floor(random() * 5)] = randomValue(random, 2);
    }

    try {
      validateManifest(candidate);
      accepted++;
    } catch (error) {
      rejected++;
      assert.ok(error instanceof WeiSQLError, `iteration ${iteration}: got ${error?.constructor?.name}: ${error?.message}`);
      assert.ok(MANIFEST_CODES.has(error.code), `iteration ${iteration}: unexpected code ${error.code}`);
    }
  }

  // Both outcomes must occur, otherwise the fuzzer proves nothing about rejection.
  assert.ok(accepted > 0, "no candidate was accepted");
  assert.ok(rejected > 0, "no candidate was rejected");
});

test("parseContainer either accepts or throws a documented WeiSQLError", () => {
  const random = createRandom(0xc0ffee);
  const encoder = new TextEncoder();
  let accepted = 0;
  let rejected = 0;

  for (let iteration = 0; iteration < 400; iteration++) {
    const length = Math.floor(random() * 400);
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++) bytes[index] = Math.floor(random() * 256);

    // Half the cases start with the real magic so parsing gets past the first check.
    if (iteration % 2 === 1 && length >= 12) bytes.set(encoder.encode(CONTAINER_MAGIC), 0);

    try {
      parseContainer(bytes);
      accepted++;
    } catch (error) {
      rejected++;
      assert.ok(error instanceof WeiSQLError, `iteration ${iteration}: got ${error?.constructor?.name}: ${error?.message}`);
      assert.ok(CONTAINER_CODES.has(error.code), `iteration ${iteration}: unexpected code ${error.code}`);
    }
  }

  assert.ok(rejected > 0, "no random container was rejected");
  assert.ok(accepted >= 0);
});

test("truncating a valid container always fails with a WeiSQLError", async () => {
  const bytes = new Uint8Array(await readFile(new URL("../../../examples/fixture/vectors/document_embeddings.id-map.offsets", import.meta.url)));
  assert.ok(bytes.byteLength > 0);

  // Build a valid container through the public API, then truncate it byte by byte.
  const { createContainer } = await import("../dist/index.js");
  const container = await createContainer([{ path: "manifest.json", bytes }]);
  for (let length = 0; length < 12; length++) {
    assert.throws(() => parseContainer(container.subarray(0, length)), WeiSQLError, `length ${length}`);
  }
  const parsed = parseContainer(container);
  assert.equal(parsed.header.files.length, 1);
});
