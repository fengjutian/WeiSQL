import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalJson, countersignManifest, generateSigningKeyPair, manifestSignatures, signManifest, validateManifest, verifyManifestSignature } from "../dist/index.js";

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
  assert.equal(verified.valid, true);
  assert.equal(verified.keyId, keys.keyId);
});

test("rejects tampering, wrong key ids and untrusted keys", async () => {
  const keys = await generateSigningKeyPair();
  const signed = await signManifest(await manifest(), { privateKeyPem: keys.privateKeyPem, publicKeyPem: keys.publicKeyPem });

  const tampered = structuredClone(signed);
  tampered.datasetId = "another-dataset";
  const tamperedResult = await verifyManifestSignature(tampered);
  assert.equal(tamperedResult.valid, false);
  assert.equal(tamperedResult.keyId, keys.keyId);
  assert.equal(tamperedResult.reason, "bad-signature");

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

test("co-signing keeps both signatures and requires all of them to verify", async () => {
  const oldKey = await generateSigningKeyPair();
  const newKey = await generateSigningKeyPair();
  const signed = await signManifest(await manifest(), { privateKeyPem: oldKey.privateKeyPem, publicKeyPem: oldKey.publicKeyPem });
  const rotated = await countersignManifest(signed, { privateKeyPem: newKey.privateKeyPem, publicKeyPem: newKey.publicKeyPem });

  assert.equal(manifestSignatures(rotated).length, 2);
  assert.deepEqual(manifestSignatures(rotated).map(item => item.keyId), [oldKey.keyId, newKey.keyId]);
  assert.equal(rotated.signature, undefined);

  const verified = await verifyManifestSignature(rotated);
  assert.equal(verified.valid, true);
  assert.deepEqual(verified.keyIds, [oldKey.keyId, newKey.keyId]);
  assert.deepEqual(verified.signatures.map(item => item.valid), [true, true]);

  // Either pinned key is enough for a rotation, but an unrelated pin is not.
  assert.equal((await verifyManifestSignature(rotated, { trustedKeyIds: [oldKey.keyId] })).valid, true);
  assert.equal((await verifyManifestSignature(rotated, { trustedKeyIds: [newKey.keyId] })).valid, true);
  assert.equal((await verifyManifestSignature(rotated, { trustedKeyIds: [`sha256:${"0".repeat(64)}`] })).reason, "untrusted-key");
});

test("rotation can drop the old signature once consumers pinned the new key", async () => {
  const oldKey = await generateSigningKeyPair();
  const newKey = await generateSigningKeyPair();
  const signed = await signManifest(await manifest(), { privateKeyPem: oldKey.privateKeyPem, publicKeyPem: oldKey.publicKeyPem });
  const rotated = await countersignManifest(signed, { privateKeyPem: newKey.privateKeyPem, publicKeyPem: newKey.publicKeyPem });

  const onlyNew = { ...rotated, signatures: rotated.signatures.filter(item => item.keyId === newKey.keyId) };
  assert.equal((await verifyManifestSignature(onlyNew, { trustedKeyIds: [newKey.keyId] })).valid, true);
  assert.equal((await verifyManifestSignature(onlyNew, { trustedKeyIds: [oldKey.keyId] })).reason, "untrusted-key");
});

test("rejects a duplicate co-signature and a mixed single/multi form", async () => {
  const keys = await generateSigningKeyPair();
  const signed = await signManifest(await manifest(), { privateKeyPem: keys.privateKeyPem, publicKeyPem: keys.publicKeyPem });
  await assert.rejects(countersignManifest(signed, { privateKeyPem: keys.privateKeyPem, publicKeyPem: keys.publicKeyPem }), { code: "INVALID_ARGUMENT" });

  const twoKeys = await generateSigningKeyPair();
  const rotated = await countersignManifest(signed, { privateKeyPem: twoKeys.privateKeyPem, publicKeyPem: twoKeys.publicKeyPem });
  assert.throws(() => validateManifest({ ...rotated, signature: rotated.signatures[0] }), { code: "MANIFEST_INVALID" });

  const duplicate = structuredClone(rotated);
  duplicate.signatures[1].keyId = duplicate.signatures[0].keyId;
  assert.throws(() => validateManifest(duplicate), { code: "MANIFEST_INVALID" });
});

test("one tampered co-signature invalidates the Manifest", async () => {
  const first = await generateSigningKeyPair();
  const second = await generateSigningKeyPair();
  const signed = await signManifest(await manifest(), { privateKeyPem: first.privateKeyPem, publicKeyPem: first.publicKeyPem });
  const rotated = await countersignManifest(signed, { privateKeyPem: second.privateKeyPem, publicKeyPem: second.publicKeyPem });

  const tampered = structuredClone(rotated);
  tampered.signatures[1].value = `A${tampered.signatures[1].value.slice(1)}`;
  const verified = await verifyManifestSignature(tampered);
  assert.equal(verified.valid, false);
  assert.deepEqual(verified.signatures.map(item => item.valid), [true, false]);
  assert.equal(verified.reason, "bad-signature");
});

test("an endorsement policy requires a minimum number of pinned signers", async () => {
  const first = await generateSigningKeyPair();
  const second = await generateSigningKeyPair();
  const signed = await signManifest(await manifest(), { privateKeyPem: first.privateKeyPem, publicKeyPem: first.publicKeyPem });
  const rotated = await countersignManifest(signed, { privateKeyPem: second.privateKeyPem, publicKeyPem: second.publicKeyPem });

  const bothPinned = await verifyManifestSignature(rotated, { trustedKeyIds: [first.keyId, second.keyId], minimumTrustedSignatures: 2 });
  assert.equal(bothPinned.valid, true);
  assert.deepEqual(bothPinned.trustedKeyIds, [first.keyId, second.keyId]);

  const onePinned = await verifyManifestSignature(rotated, { trustedKeyIds: [first.keyId], minimumTrustedSignatures: 2 });
  assert.equal(onePinned.valid, false);
  assert.equal(onePinned.reason, "insufficient-trusted-signatures");
  assert.deepEqual(onePinned.trustedKeyIds, [first.keyId]);

  // A policy without pins cannot be evaluated.
  await assert.rejects(verifyManifestSignature(rotated, { minimumTrustedSignatures: 2 }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(verifyManifestSignature(rotated, { trustedKeyIds: [first.keyId], minimumTrustedSignatures: 0 }), { code: "INVALID_ARGUMENT" });
});
