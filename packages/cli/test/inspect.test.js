import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { inspectPackage, packPackage } from "../dist/index.js";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE = path.join(REPO_ROOT, "examples", "fixture");
const BIN = fileURLToPath(new URL("../dist/bin.js", import.meta.url));

async function copyFixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "weisql-inspect-"));
  const pkg = path.join(directory, "package");
  await cp(FIXTURE, pkg, { recursive: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, pkg };
}

test("inspect summarizes the fixture", async () => {
  const summary = await inspectPackage(FIXTURE);
  assert.equal(summary.kind, "directory");
  assert.equal(summary.datasetId, "demo-documents");
  assert.deepEqual(summary.tables.map(table => table.name), ["documents"]);
  assert.deepEqual(summary.vectors.map(vector => `${vector.name}:${vector.count}x${vector.dimension}`), ["document_embeddings:3x2"]);
  assert.equal(summary.signature.present, false);
  assert.equal(summary.resources.declaredFiles, 6);
  assert.deepEqual(summary.resources.undeclared, []);
});

test("inspect reports undeclared files and pack can skip them", async (t) => {
  const { directory, pkg } = await copyFixture(t);
  await writeFile(path.join(pkg, ".env"), "SECRET=1\n", "utf8");
  await writeFile(path.join(pkg, "notes.txt"), "hello\n", "utf8");

  const summary = await inspectPackage(pkg);
  assert.deepEqual(summary.resources.undeclared, [".env", "notes.txt"]);

  const packed = await packPackage({ directory: pkg, output: path.join(directory, "pkg.wsql"), onlyDeclared: true });
  assert.equal(packed.onlyDeclared, true);
  assert.deepEqual(packed.skipped, [".env", "notes.txt"]);

  const container = await inspectPackage(packed.output);
  assert.equal(container.kind, "container");
  assert.equal(container.container?.files, 7);
  assert.deepEqual(container.resources.undeclared, []);
});

test("pack --only-declared fails when a declared resource is missing", async (t) => {
  const { directory, pkg } = await copyFixture(t);
  await rm(path.join(pkg, "vectors", "document_embeddings.f32"));

  await assert.rejects(
    packPackage({ directory: pkg, output: path.join(directory, "pkg.wsql"), onlyDeclared: true }),
    /declared resources are missing/,
  );

  const { stdout } = await run(process.execPath, [BIN, "inspect", FIXTURE, "--json"]);
  assert.equal(JSON.parse(stdout).resources.undeclared.length, 0);
});
