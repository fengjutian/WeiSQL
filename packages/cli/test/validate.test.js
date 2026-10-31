import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { validatePackage } from "../dist/index.js";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = path.join(REPO_ROOT, "examples", "fixture");
const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

async function copiedFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "weisql-cli-"));
  const target = path.join(directory, "package");
  await cp(FIXTURE, target, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return target;
}

test("accepts the example package and verifies every hash", async () => {
  const result = await validatePackage({ directory: FIXTURE });
  assert.equal(result.ok, true);
  assert.deepEqual(result.issues, []);
  assert.equal(result.manifest?.datasetId, "demo-documents");
  assert.equal(result.integrity?.checkedResources, 4);
  assert.equal(result.integrity?.sizeVerified, 4);
  assert.equal(result.integrity?.hashesVerified, 4);
});

test("manifest mode verifies sizes without claiming hashes", async () => {
  const result = await validatePackage({ directory: FIXTURE, mode: "manifest" });
  assert.equal(result.ok, true);
  assert.equal(result.integrity?.hashesVerified, 0);
  assert.equal(result.integrity?.sizeVerified, 4);
});

test("none mode only runs L1/L2", async () => {
  const result = await validatePackage({ directory: FIXTURE, mode: "none" });
  assert.equal(result.ok, true);
  assert.equal(result.integrity?.checkedResources, 0);
});

test("reports tampered content as an integrity failure", async t => {
  const target = await copiedFixture(t);
  const vector = path.join(target, "vectors", "document_embeddings.f32");
  const bytes = new Uint8Array(await readFile(vector));
  bytes[0] ^= 0xff;
  await writeFile(vector, bytes);

  const result = await validatePackage({ directory: target });
  assert.equal(result.ok, false);
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].stage, "resources");
  assert.equal(result.issues[0].code, "RESOURCE_INTEGRITY_FAILED");
  assert.equal(result.issues[0].details?.path, "vectors/document_embeddings.f32");
});

test("reports a truncated resource in manifest mode", async t => {
  const target = await copiedFixture(t);
  await truncate(path.join(target, "vectors", "document_embeddings.id-map.offsets"), 16);
  const result = await validatePackage({ directory: target, mode: "manifest" });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].code, "RESOURCE_INTEGRITY_FAILED");
});

test("reports a missing manifest and invalid JSON distinctly", async t => {
  const directory = await mkdtemp(path.join(tmpdir(), "weisql-cli-empty-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  const missing = await validatePackage({ directory });
  assert.equal(missing.ok, false);
  assert.equal(missing.issues[0].code, "RESOURCE_NOT_FOUND");

  await writeFile(path.join(directory, "manifest.json"), "{ not json", "utf8");
  const invalid = await validatePackage({ directory });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.issues[0].code, "MANIFEST_INVALID");
});

test("reports structural Manifest issues with their path", async t => {
  const target = await copiedFixture(t);
  const manifest = JSON.parse(await readFile(path.join(target, "manifest.json"), "utf8"));
  manifest.tables[0].columns[0].type = "varchar";
  await writeFile(path.join(target, "manifest.json"), JSON.stringify(manifest), "utf8");

  const result = await validatePackage({ directory: target });
  assert.equal(result.ok, false);
  assert.equal(result.issues[0].stage, "manifest");
  assert.equal(result.issues[0].code, "MANIFEST_INVALID");
  const issues = result.issues[0].details?.issues;
  assert.ok(Array.isArray(issues) && issues.length > 0);
});

test("CLI exits 0 and prints a summary for a valid package", async () => {
  const { stdout } = await run(process.execPath, [BIN, "validate", FIXTURE]);
  assert.match(stdout, /demo-documents/);
  assert.match(stdout, /4 hashes verified/);
  assert.match(stdout, /OK/);
});

test("CLI exits 1 and emits JSON for an invalid package", async t => {
  const target = await copiedFixture(t);
  const vector = path.join(target, "vectors", "document_embeddings.f32");
  const bytes = new Uint8Array(await readFile(vector));
  bytes[1] ^= 0xff;
  await writeFile(vector, bytes);

  await assert.rejects(
    run(process.execPath, [BIN, "validate", target, "--json"]),
    (error) => {
      assert.equal(error.code, 1);
      const payload = JSON.parse(error.stdout);
      assert.equal(payload.ok, false);
      assert.equal(payload.issues[0].code, "RESOURCE_INTEGRITY_FAILED");
      return true;
    },
  );
});

test("L4 verifies Parquet content against the Manifest", async t => {
  const ok = await validatePackage({ directory: FIXTURE, l4: true });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.l4, { ok: true, tables: 1 });

  const target = await copiedFixture(t);
  const manifest = JSON.parse(await readFile(path.join(target, "manifest.json"), "utf8"));
  manifest.tables[0].columns[0].type = "int32";
  await writeFile(path.join(target, "manifest.json"), JSON.stringify(manifest), "utf8");

  const broken = await validatePackage({ directory: target, l4: true });
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.l4, { ok: false, tables: 0 });
  assert.ok(broken.issues.some(issue => issue.stage === "l4" && issue.code === "RESOURCE_INTEGRITY_FAILED"));
  // Without --l4 the same package only fails at L3 (manifest.json is not hashed).
  const withoutL4 = await validatePackage({ directory: target });
  assert.equal(withoutL4.ok, true);
  assert.equal(withoutL4.l4, undefined);
});

test("CLI --l4 reports the table count and exits 0 for a valid package", async () => {
  const { stdout } = await run(process.execPath, [BIN, "validate", FIXTURE, "--l4", "--json"]);
  const payload = JSON.parse(stdout);
  assert.equal(payload.ok, true);
  assert.deepEqual(payload.l4, { ok: true, tables: 1 });
});

test("CLI treats bad usage as exit code 2", async () => {
  for (const argv of [[], ["validate"], ["validate", FIXTURE, "--mode", "bogus"], ["unknown", FIXTURE], ["validate", FIXTURE, "--nope"]]) {
    await assert.rejects(run(process.execPath, [BIN, ...argv]), error => error.code === 2, argv.join(" "));
  }
});
