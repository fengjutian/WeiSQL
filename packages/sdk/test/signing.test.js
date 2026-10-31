import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { addAuthorization, authorizeSigner, canonicalJson, countersignManifest, generateSigningKeyPair, manifestSignatures, signManifest, validateManifest, verifyAuthorizations, verifyManifestSignature } from "../dist/index.js";

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

test("a root key can authorize a release key instead of pinning it", async () => {
  const root = await generateSigningKeyPair();
  const release = await generateSigningKeyPair();
  const now = Date.parse("2026-06-01T00:00:00Z");
  const authorization = await authorizeSigner({
    rootPrivateKeyPem: root.privateKeyPem,
    rootPublicKeyPem: root.publicKeyPem,
    signerPublicKeyPem: release.publicKeyPem,
    validFrom: "2026-01-01T00:00:00Z",
    validUntil: "2027-01-01T00:00:00Z",
  });
  assert.equal(authorization.rootKeyId, root.keyId);
  assert.equal(authorization.keyId, release.keyId);

  let signed = addAuthorization(await manifest(), authorization);
  signed = await signManifest(signed, { privateKeyPem: release.privateKeyPem, publicKeyPem: release.publicKeyPem });
  assert.equal(validateManifest(signed).authorizations.length, 1);

  const pinnedRoot = await verifyManifestSignature(signed, { trustedRootKeyIds: [root.keyId], now });
  assert.equal(pinnedRoot.valid, true);
  assert.equal(pinnedRoot.authorized, true);
  assert.deepEqual(pinnedRoot.authorizations.map(item => item.valid), [true]);

  const strangerRoot = await verifyManifestSignature(signed, { trustedRootKeyIds: ["sha256:" + "0".repeat(64)], now });
  assert.equal(strangerRoot.valid, false);
  assert.equal(strangerRoot.reason, "unauthorized-root");

  const unpinned = await verifyManifestSignature(signed);
  assert.equal(unpinned.valid, true);
  assert.equal(unpinned.authorized, undefined);
});

test("authorization windows are enforced and tampering breaks the root signature", async () => {
  const root = await generateSigningKeyPair();
  const release = await generateSigningKeyPair();
  const authorization = await authorizeSigner({
    rootPrivateKeyPem: root.privateKeyPem,
    rootPublicKeyPem: root.publicKeyPem,
    signerPublicKeyPem: release.publicKeyPem,
    validFrom: "2026-01-01T00:00:00Z",
    validUntil: "2026-06-01T00:00:00Z",
  });

  let signed = addAuthorization(await manifest(), authorization);
  signed = await signManifest(signed, { privateKeyPem: release.privateKeyPem, publicKeyPem: release.publicKeyPem });

  const expired = await verifyManifestSignature(signed, { trustedRootKeyIds: [root.keyId], now: Date.parse("2026-06-01T00:00:00Z") });
  assert.equal(expired.authorizations[0].reason, "expired");
  assert.equal(expired.reason, "unauthorized-root");

  const early = await verifyManifestSignature(signed, { trustedRootKeyIds: [root.keyId], now: Date.parse("2025-12-31T00:00:00Z") });
  assert.equal(early.authorizations[0].reason, "not-yet-valid");

  const extended = structuredClone(signed);
  extended.authorizations[0].validUntil = "2030-01-01T00:00:00Z";
  const chains = await verifyAuthorizations(extended, { trustedRootKeyIds: [root.keyId], now: Date.parse("2026-03-01T00:00:00Z") });
  assert.equal(chains[0].valid, false);
  assert.equal(chains[0].reason, "root-signature");
  // The delegation is part of the signed payload, so editing it also breaks the
  // Manifest signature itself.
  assert.equal((await verifyManifestSignature(extended)).reason, "bad-signature");
});

test("authorizations require a matching signature and sane input", async () => {
  const root = await generateSigningKeyPair();
  const release = await generateSigningKeyPair();
  const other = await generateSigningKeyPair();
  const authorization = await authorizeSigner({
    rootPrivateKeyPem: root.privateKeyPem,
    rootPublicKeyPem: root.publicKeyPem,
    signerPublicKeyPem: release.publicKeyPem,
    validFrom: "2026-01-01T00:00:00Z",
    validUntil: "2027-01-01T00:00:00Z",
  });

  let signed = addAuthorization(await manifest(), authorization);
  signed = await signManifest(signed, { privateKeyPem: other.privateKeyPem, publicKeyPem: other.publicKeyPem });
  const unsigned = await verifyAuthorizations(signed, { now: Date.parse("2026-06-01T00:00:00Z") });
  assert.equal(unsigned[0].reason, "unsigned-key");

  const badWindow = structuredClone(signed);
  badWindow.authorizations[0].validFrom = "2026-06-01T00:00:00Z";
  badWindow.authorizations[0].validUntil = "2026-01-01T00:00:00Z";
  assert.throws(() => validateManifest(badWindow), { code: "MANIFEST_INVALID" });

  const duplicate = structuredClone(signed);
  duplicate.authorizations.push(structuredClone(duplicate.authorizations[0]));
  assert.throws(() => validateManifest(duplicate), { code: "MANIFEST_INVALID" });

  await assert.rejects(authorizeSigner({
    rootPrivateKeyPem: root.privateKeyPem,
    rootPublicKeyPem: root.publicKeyPem,
    signerPublicKeyPem: release.publicKeyPem,
    validFrom: "2026-06-01T00:00:00Z",
    validUntil: "2026-01-01T00:00:00Z",
  }), { code: "INVALID_ARGUMENT" });
});
