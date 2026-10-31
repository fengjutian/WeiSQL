import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { validatePackage } from "../dist/index.js";
import { verifyManifestSignature } from "@weisql/sdk";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = path.join(REPO_ROOT, "examples", "fixture");
const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

async function workspace(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "weisql-cli-sign-"));
  const pkg = path.join(directory, "package");
  await cp(FIXTURE, pkg, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, pkg };
}

test("keygen writes a pair and sign/verify work on a directory", async (t) => {
  const { directory, pkg } = await workspace(t);
  const prefix = path.join(directory, "key");
  const { stdout: generated } = await run(process.execPath, [BIN, "keygen", "--output", prefix, "--json"]);
  const keys = JSON.parse(generated);
  assert.match(keys.keyId, /^sha256:[a-f0-9]{64}$/);
  assert.match(await readFile(keys.privateKeyPath, "utf8"), /BEGIN PRIVATE KEY/);
  assert.match(await readFile(keys.publicKeyPath, "utf8"), /BEGIN PUBLIC KEY/);

  const { stdout: signed } = await run(process.execPath, [BIN, "sign", pkg, "--key", keys.privateKeyPath, "--json"]);
  assert.equal(JSON.parse(signed).keyId, keys.keyId);

  const { stdout: verified } = await run(process.execPath, [BIN, "verify-signature", pkg, "--json"]);
  assert.equal(JSON.parse(verified).valid, true);

  const result = await validatePackage({ directory: pkg, signature: true, trustedKeyIds: [keys.keyId] });
  assert.equal(result.ok, true);
  assert.equal(result.signature?.valid, true);
});

test("tampering invalidates the signature and validate reports it", async (t) => {
  const { directory, pkg } = await workspace(t);
  const prefix = path.join(directory, "key");
  await run(process.execPath, [BIN, "keygen", "--output", prefix]);
  await run(process.execPath, [BIN, "sign", pkg, "--key", `${prefix}.key.pem`]);

  const wrongTrust = await validatePackage({ directory: pkg, signature: true, trustedKeyIds: [`sha256:${"0".repeat(64)}`] });
  assert.equal(wrongTrust.signature?.reason, "untrusted-key");

  const manifestPath = path.join(pkg, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.datasetId = "tampered";
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  const result = await validatePackage({ directory: pkg, signature: true });
  assert.equal(result.ok, false);
  assert.equal(result.signature?.reason, "bad-signature");
  assert.ok(result.issues.some(issue => issue.stage === "signature"));

});

test("signs and verifies a .wsql container", async (t) => {
  const { directory, pkg } = await workspace(t);
  const container = path.join(directory, "package.wsql");
  const prefix = path.join(directory, "key");
  await run(process.execPath, [BIN, "keygen", "--output", prefix]);
  await run(process.execPath, [BIN, "pack", pkg, "--output", container]);

  const { stdout: signed } = await run(process.execPath, [BIN, "sign", container, "--key", `${prefix}.key.pem`, "--json"]);
  assert.equal(JSON.parse(signed).kind, "container");

  const { stdout: verified } = await run(process.execPath, [BIN, "verify-signature", container, "--json"]);
  const report = JSON.parse(verified);
  assert.equal(report.valid, true);
  assert.equal(report.kind, "container");

  const { stdout: validated } = await run(process.execPath, [BIN, "validate", container, "--signature", "--json"]);
  assert.equal(JSON.parse(validated).ok, true);
});

test("validate --signature requires a signature", async () => {
  const result = await validatePackage({ directory: FIXTURE, signature: true });
  assert.equal(result.ok, false);
  assert.equal(result.signature?.reason, "missing-signature");
  const unsigned = await validatePackage({ directory: FIXTURE });
  assert.equal(unsigned.ok, true);
  assert.equal(unsigned.signature, undefined);
});

test("countersigning keeps both signatures and validates with either pin", async (t) => {
  const { directory, pkg } = await workspace(t);
  const first = path.join(directory, "first");
  const second = path.join(directory, "second");
  const { stdout: firstKey } = await run(process.execPath, [BIN, "keygen", "--output", first, "--json"]);
  const { stdout: secondKey } = await run(process.execPath, [BIN, "keygen", "--output", second, "--json"]);
  const firstId = JSON.parse(firstKey).keyId;
  const secondId = JSON.parse(secondKey).keyId;

  await run(process.execPath, [BIN, "sign", pkg, "--key", `${first}.key.pem`]);
  const { stdout: coSigned } = await run(process.execPath, [BIN, "sign", pkg, "--key", `${second}.key.pem`, "--add", "--json"]);
  assert.deepEqual(JSON.parse(coSigned).keyIds, [firstId, secondId]);

  const { stdout: verified } = await run(process.execPath, [BIN, "verify-signature", pkg, "--json"]);
  const report = JSON.parse(verified);
  assert.equal(report.valid, true);
  assert.deepEqual(report.keyIds, [firstId, secondId]);

  const pinned = await validatePackage({ directory: pkg, signature: true, trustedKeyIds: [secondId] });
  assert.equal(pinned.ok, true);
  const unpinned = await validatePackage({ directory: pkg, signature: true, trustedKeyIds: [`sha256:${"0".repeat(64)}`] });
  assert.equal(unpinned.signature?.reason, "untrusted-key");
});
