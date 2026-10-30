import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { NodeFileResourceReader } from "../dist/index.js";

async function fixture(t) {
  const workspace = await mkdtemp(path.join(tmpdir(), "weisql-reader-"));
  const root = path.join(workspace, "package");
  await mkdir(path.join(root, "data"), { recursive: true });
  await writeFile(path.join(root, "data", "bytes.bin"), new Uint8Array([0, 1, 2, 3, 4, 5]));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  return { workspace, root };
}

test("Node reader reads complete resources, exact ranges and metadata", async t => {
  const { root } = await fixture(t);
  const reader = new NodeFileResourceReader({ rootDirectory: root });
  assert.deepEqual([...await reader.read("data/bytes.bin")], [0, 1, 2, 3, 4, 5]);
  assert.deepEqual([...await reader.readRange("data/bytes.bin", { start: 2, end: 5 })], [2, 3, 4]);
  assert.equal((await reader.readRange("data/bytes.bin", { start: 3, end: 3 })).byteLength, 0);
  const metadata = await reader.stat("data/bytes.bin");
  assert.equal(metadata.size, 6);
  assert.equal(metadata.supportsRange, true);
});

test("Node reader enforces paths, root containment and regular files", async t => {
  const { workspace, root } = await fixture(t);
  const outside = path.join(workspace, "outside.bin");
  await writeFile(outside, new Uint8Array([9]));
  const reader = new NodeFileResourceReader({ rootDirectory: root });
  await assert.rejects(reader.read("../outside.bin"), { code: "PATH_INVALID" });
  await assert.rejects(reader.read("missing.bin"), { code: "RESOURCE_NOT_FOUND" });
  await assert.rejects(reader.read("data"), { code: "RESOURCE_NOT_FOUND" });
  try {
    await symlink(outside, path.join(root, "data", "escape.bin"));
    await assert.rejects(reader.read("data/escape.bin"), { code: "PATH_INVALID" });
  } catch (error) {
    if (error?.code !== "EPERM") throw error;
  }
});

test("Node reader rejects overflow, truncation, cancellation, limits and closed use", async t => {
  const { root } = await fixture(t);
  const reader = new NodeFileResourceReader({ rootDirectory: root, maxReadBytes: 5 });
  await assert.rejects(reader.read("data/bytes.bin"), { code: "RESOURCE_INTEGRITY_FAILED" });
  await assert.rejects(reader.readRange("data/bytes.bin", { start: 0, end: 7 }), { code: "RESOURCE_INTEGRITY_FAILED" });
  await assert.rejects(reader.readRange("data/bytes.bin", { start: Number.MAX_SAFE_INTEGER, end: Number.MAX_SAFE_INTEGER + 1 }), { code: "INVALID_ARGUMENT" });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(reader.stat("data/bytes.bin", { signal: controller.signal }), { code: "QUERY_CANCELLED" });
  await reader.close(); await reader.close();
  await assert.rejects(reader.stat("data/bytes.bin"), { code: "DATABASE_CLOSED" });
});
