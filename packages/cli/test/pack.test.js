import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { packPackage, unpackContainer, validateContainer, validatePackage } from "../dist/index.js";
import { parseContainer } from "@weisql/sdk";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = path.join(REPO_ROOT, "examples", "fixture");
const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

async function packedFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "weisql-pack-"));
  const output = path.join(directory, "package.wsql");
  const result = await packPackage({ directory: FIXTURE, output });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { output, result };
}

test("packs the fixture and validates the container", async (t) => {
  const { output, result } = await packedFixture(t);
  assert.equal(result.files.length, 7);
  assert.ok(result.containerBytes > 0);

  const validation = await validateContainer({ file: output });
  assert.equal(validation.ok, true);
  assert.deepEqual(validation.issues, []);
  assert.equal(validation.container?.files, 7);
  assert.equal(validation.container?.mismatches, 0);
  assert.equal(validation.integrity?.checkedResources, 6);
  assert.equal(validation.integrity?.hashesVerified, 6);
});

test("detects a tampered container", async (t) => {
  const { output } = await packedFixture(t);
  const bytes = new Uint8Array(await readFile(output));
  bytes[bytes.byteLength - 1] ^= 0xff;
  await writeFile(output, bytes);

  const validation = await validateContainer({ file: output });
  assert.equal(validation.ok, false);
  assert.equal(validation.container?.mismatches, 1);
  assert.ok(validation.issues.some(issue => issue.code === "RESOURCE_INTEGRITY_FAILED"));
});

test("manifest mode validates the container without hashing entries", async (t) => {
  const { output } = await packedFixture(t);
  const validation = await validateContainer({ file: output, mode: "manifest" });
  assert.equal(validation.ok, true);
  assert.equal(validation.container?.mismatches, 0);
  assert.equal(validation.integrity?.hashesVerified, 0);
  assert.equal(validation.integrity?.sizeVerified, 6);
});

test("L4 checks Parquet content inside a container", async (t) => {
  const { output } = await packedFixture(t);
  const ok = await validateContainer({ file: output, l4: true });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.l4, { ok: true, tables: 1 });

  // A Manifest that disagrees with the Parquet types must fail L4, not L1/L2.
  const directory = path.join(path.dirname(output), "bad");
  await unpackContainer({ file: output, directory });
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.tables[0].columns[1].type = "int32";
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  const broken = await validateContainer({ file: (await packPackage({ directory })).output, l4: true });
  assert.equal(broken.ok, false);
  assert.deepEqual(broken.l4, { ok: false, tables: 0 });
  assert.ok(broken.issues.some(issue => issue.stage === "l4" && issue.code === "RESOURCE_INTEGRITY_FAILED"));
});

test("unpacks a container into a directory that validates", async (t) => {
  const { output } = await packedFixture(t);
  const directory = path.join(path.dirname(output), "unpacked");
  const unpacked = await unpackContainer({ file: output, directory });
  assert.equal(unpacked.files.length, 7);
  assert.equal(unpacked.digestsVerified, 7);
  assert.ok(unpacked.bytes > 0);

  const validation = await validatePackage({ directory });
  assert.equal(validation.ok, true);
  assert.equal(validation.integrity?.checkedResources, 6);

  const original = await readFile(path.join(FIXTURE, "manifest.json"));
  const extracted = await readFile(path.join(directory, "manifest.json"));
  assert.deepEqual(new Uint8Array(extracted), new Uint8Array(original));
});

test("unpack refuses a tampered container before writing anything", async (t) => {
  const { output } = await packedFixture(t);
  const bytes = new Uint8Array(await readFile(output));
  bytes[bytes.byteLength - 1] ^= 0xff;
  await writeFile(output, bytes);

  const directory = path.join(path.dirname(output), "should-not-exist");
  await assert.rejects(unpackContainer({ file: output, directory }), /digests do not match/);
  await assert.rejects(readFile(path.join(directory, "manifest.json")));
});

test("packs a compressed container that still validates", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "weisql-pack-gzip-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "package.wsql");

  const packed = await packPackage({ directory: FIXTURE, output, compress: true });
  assert.equal(packed.compressed, true);

  const parsed = parseContainer(new Uint8Array(await readFile(output)));
  assert.equal(parsed.header.formatVersion, "1.1.0");
  assert.equal(parsed.header.compression, "gzip");

  const validation = await validateContainer({ file: output });
  assert.equal(validation.ok, true);
  assert.equal(validation.integrity?.checkedResources, 6);
  assert.equal(validation.integrity?.hashesVerified, 6);

  const unpacked = await unpackContainer({ file: output, directory: path.join(directory, "out") });
  assert.equal(unpacked.files.length, 7);
  assert.equal(unpacked.digestsVerified, 7);
});

test("CLI pack --compress writes a streaming-readable container", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "weisql-pack-cli-gzip-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "package.wsql");

  const packed = await run(process.execPath, [BIN, "pack", FIXTURE, "--compress", "--output", output, "--json"]);
  const summary = JSON.parse(packed.stdout);
  assert.equal(summary.compressed, true);

  const validated = await run(process.execPath, [BIN, "validate", output, "--json"]);
  const report = JSON.parse(validated.stdout);
  assert.equal(report.ok, true);
});

test("CLI pack and validate round-trip a container", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "weisql-pack-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "package.wsql");

  const packed = await run(process.execPath, [BIN, "pack", FIXTURE, "--output", output, "--json"]);
  const summary = JSON.parse(packed.stdout);
  assert.equal(summary.files.length, 7);
  assert.equal(summary.output, output);

  const validated = await run(process.execPath, [BIN, "validate", output, "--json"]);
  const report = JSON.parse(validated.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.kind, "container");
  assert.equal(report.container.files, 7);
  assert.equal(report.datasetId, "demo-documents");
});

test("CLI pack fails without a manifest and on bad usage", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "weisql-pack-empty-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await assert.rejects(
    run(process.execPath, [BIN, "pack", directory]),
    (error) => error.code === 1 && String(error.stderr).includes("manifest.json"),
  );
  await assert.rejects(
    run(process.execPath, [BIN, "pack"]),
    (error) => error.code === 2,
  );
});
