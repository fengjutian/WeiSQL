import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalJson, generateSigningKeyPair, signManifest, validateManifest, verifyManifestSignature } from "../dist/index.js";

async function manifest() {
  return JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
}

test("canonical JSON sorts keys and keeps arrays in order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
  assert.equal(canonicalJson({ list: [3, 1, 2], nested: [{ z: 1, a: 2 }] }), '{"list":[3,1,2],"nested":[{"a":2,"z":1}]}');
  assert.equal(canonicalJson({ skip: undefined, keep: null }), '{"keep":null}');
  assert.throws(() => canonicalJson({ value: Number.NaN }), { code: "INVALID_ARGUMENT" });
});

test("signs a Manifest and verifies it", async () => {
  const keys = await generateSigningKeyPair();
  const signed = await signManifest(await manifest(), { privateKeyPem: keys.privateKeyPem, publicKeyPem: keys.publicKeyPem });

  assert.equal(signed.signature.algorithm, "ed25519");
  assert.equal(signed.signature.keyId, keys.keyId);
  assert.equal(validateManifest(signed).signature.keyId, keys.keyId);

  const verified = await verifyManifestSignature(signed);
  assert.deepEqual(verified, { valid: true, keyId: keys.keyId });
});

test("rejects tampering, wrong key ids and untrusted keys", async () => {
  const keys = await generateSigningKeyPair();
  const signed = await signManifest(await manifest(), { privateKeyPem: keys.privateKeyPem, publicKeyPem: keys.publicKeyPem });

  const tampered = structuredClone(signed);
  tampered.datasetId = "another-dataset";
  assert.deepEqual(await verifyManifestSignature(tampered), { valid: false, keyId: keys.keyId, reason: "bad-signature" });

  const wrongId = structuredClone(signed);
  wrongId.signature.keyId = `sha256:${"0".repeat(64)}`;
  assert.equal((await verifyManifestSignature(wrongId)).reason, "key-id-mismatch");

  assert.equal((await verifyManifestSignature(signed, { trustedKeyIds: [`sha256:${"1".repeat(64)}`] })).reason, "untrusted-key");
  assert.equal((await verifyManifestSignature(signed, { trustedKeyIds: [keys.keyId] })).valid, true);

  const unsigned = await manifest();
  assert.equal((await verifyManifestSignature(unsigned)).reason, "missing-signature");
});

test("validateManifest checks the signature shape but not the cryptography", async () => {
  const keys = await generateSigningKeyPair();
  const signed = await signManifest(await manifest(), { privateKeyPem: keys.privateKeyPem, publicKeyPem: keys.publicKeyPem });

  const badAlgorithm = structuredClone(signed);
  badAlgorithm.signature.algorithm = "rsa";
  assert.throws(() => validateManifest(badAlgorithm), { code: "MANIFEST_INVALID" });

  const badValue = structuredClone(signed);
  badValue.signature.value = "AAAA";
  assert.throws(() => validateManifest(badValue), { code: "MANIFEST_INVALID" });

  const extraField = structuredClone(signed);
  extraField.signature.note = "hello";
  assert.throws(() => validateManifest(extraField), { code: "MANIFEST_INVALID" });
});
