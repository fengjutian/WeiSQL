import assert from "node:assert/strict";
import test from "node:test";

import { CONTAINER_MAGIC, ContainerReader, createContainer, parseContainer } from "../dist/index.js";

const encoder = new TextEncoder();

function files() {
  return [
    { path: "manifest.json", bytes: encoder.encode('{"format":"weisql"}\n') },
    { path: "data/table.parquet", bytes: new Uint8Array([1, 2, 3, 4, 5]) },
  ];
}

test("round-trips files through a container", async () => {
  const bytes = await createContainer(files());
  const parsed = parseContainer(bytes);
  assert.equal(parsed.header.formatVersion, "1.0.0");
  assert.deepEqual(parsed.header.files.map(entry => entry.path), ["manifest.json", "data/table.parquet"]);
  assert.deepEqual(parsed.header.files.map(entry => entry.offset), [0, encoder.encode('{"format":"weisql"}\n').byteLength]);

  const reader = new ContainerReader(bytes);
  assert.equal(new TextDecoder().decode(await reader.read("manifest.json")), '{"format":"weisql"}\n');
  assert.deepEqual([...await reader.readRange("data/table.parquet", { start: 1, end: 4 })], [2, 3, 4]);
  assert.deepEqual(await reader.stat("data/table.parquet"), { size: 5, supportsRange: true });
  assert.deepEqual(await reader.verify(), []);
  await reader.close();
});

test("the header starts with the documented magic and length", async () => {
  const bytes = await createContainer(files());
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 8)), CONTAINER_MAGIC);
  const headerBytes = new DataView(bytes.buffer).getUint32(8, true);
  assert.ok(headerBytes > 0 && headerBytes < bytes.byteLength);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerBytes)));
  assert.equal(header.files[0].path, "manifest.json");
});

test("verify detects tampered file bytes", async () => {
  const bytes = await createContainer(files());
  const parsed = parseContainer(bytes);
  const dataStart = parsed.dataStart + parsed.header.files[1].offset;
  bytes[dataStart] ^= 0xff;
  const mismatches = await new ContainerReader(bytes).verify();
  assert.equal(mismatches.length, 1);
  assert.equal(mismatches[0].path, "data/table.parquet");
  assert.notEqual(mismatches[0].expected, mismatches[0].actual);
});

test("rejects corrupt magic, truncated headers and trailing bytes", async () => {
  const bytes = await createContainer(files());

  const badMagic = bytes.slice();
  badMagic[0] = 0x58;
  assert.throws(() => parseContainer(badMagic), { code: "RESOURCE_INTEGRITY_FAILED" });

  assert.throws(() => parseContainer(bytes.subarray(0, 10)), { code: "RESOURCE_INTEGRITY_FAILED" });

  const trailing = new Uint8Array(bytes.byteLength + 1);
  trailing.set(bytes);
  assert.throws(() => parseContainer(trailing), { code: "RESOURCE_INTEGRITY_FAILED" });

  const badLength = bytes.slice();
  new DataView(badLength.buffer).setUint32(8, 1_000_000, true);
  assert.throws(() => parseContainer(badLength), { code: "RESOURCE_INTEGRITY_FAILED" });

  // Regression: non-UTF-8 magic bytes used to escape as a TypeError.
  const hostile = bytes.slice();
  hostile.set([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8], 0);
  assert.throws(() => parseContainer(hostile), { code: "RESOURCE_INTEGRITY_FAILED" });
});

test("round-trips a gzip-compressed container (format 1.1.0)", async () => {
  const source = [
    { path: "manifest.json", bytes: encoder.encode('{"format":"weisql"}\n') },
    { path: "data/table.parquet", bytes: new Uint8Array(4096).fill(7) },
  ];
  const bytes = await createContainer(source, { compress: true });
  const parsed = parseContainer(bytes);
  assert.equal(parsed.header.formatVersion, "1.1.0");
  assert.equal(parsed.header.compression, "gzip");
  assert.ok(parsed.header.files[1].storedBytes < parsed.header.files[1].bytes);

  const reader = new ContainerReader(bytes);
  assert.deepEqual(await reader.read("data/table.parquet"), source[1].bytes);
  assert.deepEqual(await reader.readRange("data/table.parquet", { start: 10, end: 20 }), new Uint8Array(10).fill(7));
  assert.equal((await reader.stat("data/table.parquet")).size, 4096);
  assert.deepEqual(await reader.verify(), []);
  await reader.close();
});

test("compressed containers report corrupted blocks and reject bad headers", async () => {
  const bytes = await createContainer([{ path: "manifest.json", bytes: encoder.encode("hello hello hello hello") }], { compress: true });
  const parsed = parseContainer(bytes);
  const tampered = bytes.slice();
  tampered[parsed.dataStart] ^= 0xff;
  const reader = new ContainerReader(tampered);
  const mismatches = await reader.verify();
  assert.equal(mismatches.length, 1);

  // 1.0.0 must not declare compression.
  const header = encoder.encode(JSON.stringify({
    formatVersion: "1.0.0",
    compression: "gzip",
    files: [{ path: "a", offset: 0, bytes: 1, sha256: "0".repeat(64) }],
  }));
  const container = new Uint8Array(12 + header.byteLength + 1);
  container.set(encoder.encode(CONTAINER_MAGIC), 0);
  new DataView(container.buffer).setUint32(8, header.byteLength, true);
  container.set(header, 12);
  assert.throws(() => parseContainer(container), { code: "RESOURCE_INTEGRITY_FAILED" });

  const future = encoder.encode(JSON.stringify({ formatVersion: "2.0.0", files: [] }));
  const unsupported = new Uint8Array(12 + future.byteLength);
  unsupported.set(encoder.encode(CONTAINER_MAGIC), 0);
  new DataView(unsupported.buffer).setUint32(8, future.byteLength, true);
  unsupported.set(future, 12);
  assert.throws(() => parseContainer(unsupported), { code: "FORMAT_VERSION_UNSUPPORTED" });
});

test("rejects duplicate paths and empty containers", async () => {
  await assert.rejects(createContainer([]), { code: "INVALID_ARGUMENT" });
  await assert.rejects(
    createContainer([{ path: "a", bytes: new Uint8Array(1) }, { path: "a", bytes: new Uint8Array(1) }]),
    { code: "INVALID_ARGUMENT" },
  );
  await assert.rejects(createContainer([{ path: "", bytes: new Uint8Array(1) }]), { code: "INVALID_ARGUMENT" });
});

test("rejects unsafe entry paths on both write and read", async () => {
  await assert.rejects(createContainer([{ path: "../evil.txt", bytes: new Uint8Array(1) }]), { code: "INVALID_ARGUMENT" });
  await assert.rejects(createContainer([{ path: "/abs.txt", bytes: new Uint8Array(1) }]), { code: "INVALID_ARGUMENT" });
  await assert.rejects(createContainer([{ path: "a\\b.txt", bytes: new Uint8Array(1) }]), { code: "INVALID_ARGUMENT" });

  // Craft a header that a malicious packer could produce.
  const header = JSON.stringify({
    formatVersion: "1.0.0",
    files: [{ path: "../evil.txt", offset: 0, bytes: 1, sha256: "0".repeat(64) }],
  });
  const headerBytes = encoder.encode(header);
  const bytes = new Uint8Array(12 + headerBytes.byteLength + 1);
  bytes.set(encoder.encode(CONTAINER_MAGIC), 0);
  new DataView(bytes.buffer).setUint32(8, headerBytes.byteLength, true);
  bytes.set(headerBytes, 12);
  assert.throws(() => parseContainer(bytes), { code: "RESOURCE_INTEGRITY_FAILED" });
});

test("rejects non-contiguous entries and unknown paths", async () => {
  const header = JSON.stringify({
    formatVersion: "1.0.0",
    files: [{ path: "a", offset: 1, bytes: 1, sha256: "0".repeat(64) }],
  });
  const headerBytes = encoder.encode(header);
  const bytes = new Uint8Array(12 + headerBytes.byteLength + 1);
  bytes.set(encoder.encode(CONTAINER_MAGIC), 0);
  new DataView(bytes.buffer).setUint32(8, headerBytes.byteLength, true);
  bytes.set(headerBytes, 12);
  assert.throws(() => parseContainer(bytes), { code: "RESOURCE_INTEGRITY_FAILED" });

  const reader = new ContainerReader(await createContainer(files()));
  await assert.rejects(reader.read("missing.txt"), { code: "INDEX_NOT_FOUND" });
  await assert.rejects(reader.readRange("data/table.parquet", { start: 3, end: 9 }), { code: "RESOURCE_INTEGRITY_FAILED" });
  await reader.close();
  await assert.rejects(reader.read("manifest.json"), { code: "DATABASE_CLOSED" });
});
