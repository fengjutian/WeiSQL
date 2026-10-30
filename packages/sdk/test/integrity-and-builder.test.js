import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parquetReadObjects } from "hyparquet";

import {
  NodeFileResourceReader,
  Sha256,
  buildPackage,
  open,
  sha256Hex,
  validateIdMapContent,
  verifyManifestResources,
} from "../dist/index.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCE_PARQUET = path.join(REPO_ROOT, "examples", "source", "documents.parquet");
const FIXTURE = path.join(REPO_ROOT, "examples", "fixture");

const COLUMNS = [
  { name: "id", type: "string", nullable: false },
  { name: "title", type: "string", nullable: false },
  { name: "category", type: "string", nullable: false },
];
const IDS = ["doc-001", "doc-002", "doc-003"];
const VECTORS = [
  [1, 0],
  [0.9, 0.1],
  [0, 1],
];

async function temporaryDirectory(t, label) {
  const directory = await mkdtemp(path.join(tmpdir(), `weisql-${label}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function buildOptions(outputDirectory, overrides = {}) {
  return {
    outputDirectory,
    datasetId: "demo-documents",
    tables: [
      {
        name: "documents",
        parquetPath: SOURCE_PARQUET,
        columns: COLUMNS,
        primaryKey: ["id"],
        rowIds: IDS,
      },
    ],
    vectorCollections: [
      {
        name: "document_embeddings",
        tableName: "documents",
        idColumn: "id",
        metric: "cosine",
        vectors: VECTORS,
        ids: IDS,
      },
    ],
    ...overrides,
  };
}

async function buildTempPackage(t, overrides = {}) {
  const directory = await temporaryDirectory(t, "build");
  const target = path.join(directory, "package");
  const report = await buildPackage(buildOptions(target, overrides));
  return { directory, target, report };
}

function uint64(values) {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setBigUint64(index * 8, BigInt(value), true));
  return bytes;
}

test("SHA-256 matches node:crypto across block boundaries and chunked updates", () => {
  for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 65537]) {
    const data = new Uint8Array(length);
    for (let i = 0; i < length; i++) data[i] = (i * 31 + 7) & 0xff;
    const expected = createHash("sha256").update(data).digest("hex");
    assert.equal(sha256Hex(data), expected, `length ${length}`);
    const incremental = new Sha256();
    for (let offset = 0; offset < length; offset += 97) incremental.update(data.subarray(offset, Math.min(length, offset + 97)));
    assert.equal(Buffer.from(incremental.digest()).toString("hex"), expected, `chunked length ${length}`);
  }
});

test("Builder publishes a package whose Manifest matches real bytes and digests", async t => {
  const { target, report } = await buildTempPackage(t);
  assert.equal(report.stage, "PUBLISHED");
  assert.equal(report.warnings.length, 0);

  for (const artifact of report.artifacts) {
    const bytes = await readFile(path.join(target, artifact.path));
    assert.equal(bytes.byteLength, artifact.bytes, artifact.path);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), artifact.sha256, artifact.path);
  }

  const manifest = JSON.parse(await readFile(path.join(target, "manifest.json"), "utf8"));
  const tableFile = manifest.tables[0].file;
  const parquet = await readFile(path.join(target, tableFile.path));
  assert.equal(tableFile.bytes, parquet.byteLength);
  assert.equal(tableFile.sha256, createHash("sha256").update(parquet).digest("hex"));

  const collection = manifest.vectorCollections[0];
  assert.equal(collection.count, 3);
  assert.equal(collection.dimension, 2);
  assert.equal(collection.idMap.count, 3);
  assert.equal(collection.idMap.uniqueIds, true);
  assert.equal(collection.data.bytes, 3 * 2 * 4);
  assert.equal(collection.idMap.offsets.bytes, 3 * 8);
  assert.equal(report.integrity.checkedResources, 4);
  assert.equal(report.integrity.hashesVerified, 4);
  assert.ok(report.artifacts.some(artifact => artifact.path === "manifest.json"));
});

test("Builder warns instead of pretending to verify primary-key membership", async t => {
  const table = {
    name: "documents",
    parquetPath: SOURCE_PARQUET,
    columns: COLUMNS,
    primaryKey: ["id"],
  };
  const { report } = await buildTempPackage(t, { tables: [table] });
  assert.deepEqual(report.warnings, ["id-membership-unverified:document_embeddings"]);
});

test("Builder output is readable by an independent Parquet reader", async t => {
  const { target } = await buildTempPackage(t);
  const bytes = new Uint8Array(await readFile(path.join(target, "data", "documents.parquet")));
  const rows = await parquetReadObjects({ file: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
  assert.deepEqual(rows.map(row => row.id), IDS);
  assert.deepEqual(rows.map(row => row.title), ["DNA 缁撴瀯", "RNA 杞綍", "缁嗚優浠ｈ阿"]);
  assert.deepEqual(rows.map(row => row.category), ["genetics", "genetics", "metabolism"]);
});

test("open() with verifyChecksums 'all' verifies resources before serving", async t => {
  const { target } = await buildTempPackage(t);
  const manifest = JSON.parse(await readFile(path.join(target, "manifest.json"), "utf8"));
  const reader = new NodeFileResourceReader({ rootDirectory: target });
  const db = await open({ manifest, resourceReader: reader, verifyChecksums: "all", mode: "readonly" });
  t.after(() => db.close());
  const hits = await db.vector.search("document_embeddings", [1, 0], { topK: 3 });
  assert.deepEqual(hits.map(hit => hit.id), IDS);
  assert.deepEqual(hits.map(hit => hit.row), [0, 1, 2]);
  assert.ok(Math.abs(hits[0].distance - 0) < 1e-6);
  assert.ok(Math.abs(hits[1].distance - 0.006116) < 1e-5);
  assert.ok(Math.abs(hits[2].distance - 1) < 1e-6);
  assert.equal(hits[0].diagnostics.exact, true);
});

test("'manifest' mode verifies sizes without claiming to verify hashes", async t => {
  const { target } = await buildTempPackage(t);
  const manifest = JSON.parse(await readFile(path.join(target, "manifest.json"), "utf8"));
  const reader = new NodeFileResourceReader({ rootDirectory: target });
  const report = await verifyManifestResources({ manifest, reader, options: { mode: "manifest" } });
  assert.deepEqual(report, { checkedResources: 4, sizeVerified: 4, hashesVerified: 0, totalDeclaredBytes: 832 + 24 + 75 + 24 });
  const none = await verifyManifestResources({ manifest, reader, options: { mode: "none" } });
  assert.deepEqual(none, { checkedResources: 0, sizeVerified: 0, hashesVerified: 0, totalDeclaredBytes: 0 });
});

test("tampered content is rejected by 'all' but invisible to 'manifest'", async t => {
  const { target } = await buildTempPackage(t);
  const manifestPath = path.join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const vectorPath = path.join(target, manifest.vectorCollections[0].data.path);
  const bytes = new Uint8Array(await readFile(vectorPath));
  bytes[0] ^= 0xff;
  await writeFile(vectorPath, bytes);

  await assert.rejects(
    open({ manifest, resourceReader: new NodeFileResourceReader({ rootDirectory: target }), verifyChecksums: "all" }),
    { code: "RESOURCE_INTEGRITY_FAILED" },
  );
  const lenient = await open({ manifest, resourceReader: new NodeFileResourceReader({ rootDirectory: target }), verifyChecksums: "manifest" });
  assert.equal(lenient.state, "READY");
  await lenient.close();
  const unverified = await open({ manifest, resourceReader: new NodeFileResourceReader({ rootDirectory: target }) });
  assert.equal(unverified.state, "READY");
  await unverified.close();
});

test("truncated content is rejected even in 'manifest' mode", async t => {
  const { target } = await buildTempPackage(t);
  const manifest = JSON.parse(await readFile(path.join(target, "manifest.json"), "utf8"));
  const offsets = path.join(target, manifest.vectorCollections[0].idMap.offsets.path);
  const bytes = new Uint8Array(await readFile(offsets));
  await writeFile(offsets, bytes.subarray(0, bytes.byteLength - 8));
  await assert.rejects(
    open({ manifest, resourceReader: new NodeFileResourceReader({ rootDirectory: target }), verifyChecksums: "manifest" }),
    { code: "RESOURCE_INTEGRITY_FAILED" },
  );
});

test("verifyChecksums refuses to run without a resource reader", async t => {
  const { target } = await buildTempPackage(t);
  const manifest = JSON.parse(await readFile(path.join(target, "manifest.json"), "utf8"));
  await assert.rejects(open({ manifest, verifyChecksums: "all" }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(open({ manifest, resourceReader: new NodeFileResourceReader({ rootDirectory: target }), verifyChecksums: "sometimes" }), { code: "INVALID_ARGUMENT" });
});

test("budgets fail before any resource is read", async t => {
  const { target } = await buildTempPackage(t);
  const manifest = JSON.parse(await readFile(path.join(target, "manifest.json"), "utf8"));
  const reader = new NodeFileResourceReader({ rootDirectory: target });
  await assert.rejects(verifyManifestResources({ manifest, reader, options: { mode: "all", maxResourceBytes: 64 } }), { code: "RESOURCE_INTEGRITY_FAILED" });
  await assert.rejects(verifyManifestResources({ manifest, reader, options: { mode: "all", maxTotalBytes: 64 } }), { code: "RESOURCE_INTEGRITY_FAILED" });
  await assert.rejects(verifyManifestResources({ manifest, reader, options: { mode: "all", maxTotalBytes: 0 } }), { code: "INVALID_ARGUMENT" });
});

test("Builder refuses to overwrite without permission and cleans its staging area", async t => {
  const { directory, target } = await buildTempPackage(t);
  await assert.rejects(buildPackage(buildOptions(target)), { code: "INVALID_ARGUMENT" });
  const leftovers = (await readdir(directory)).filter(name => name.includes(".staging-") || name.includes(".old-"));
  assert.deepEqual(leftovers, []);

  const rebuilt = await buildPackage(buildOptions(target, { overwrite: true }));
  assert.equal(rebuilt.stage, "PUBLISHED");
  const after = (await readdir(directory)).filter(name => name.includes(".staging-") || name.includes(".old-"));
  assert.deepEqual(after, []);
});

test("Builder rejects invalid vectors, IDs and table references", async t => {
  const directory = await temporaryDirectory(t, "reject");
  const cases = [
    ["duplicate ids", { vectorCollections: [{ ...buildOptions("x").vectorCollections[0], ids: ["doc-001", "doc-001", "doc-003"] }] }, "INVALID_ARGUMENT"],
    ["dimension mismatch", { vectorCollections: [{ ...buildOptions("x").vectorCollections[0], vectors: [[1, 0], [1, 0, 0], [0, 1]] }] }, "INVALID_ARGUMENT"],
    ["unknown table", { vectorCollections: [{ ...buildOptions("x").vectorCollections[0], tableName: "missing" }] }, "INVALID_ARGUMENT"],
    ["zero cosine vector", { vectorCollections: [{ ...buildOptions("x").vectorCollections[0], vectors: [[1, 0], [0, 0], [0, 1]] }] }, "INVALID_ARGUMENT"],
    ["non-finite value", { vectorCollections: [{ ...buildOptions("x").vectorCollections[0], vectors: [[1, 0], [Number.NaN, 0.1], [0, 1]] }] }, "INVALID_ARGUMENT"],
    ["id outside primary key", { vectorCollections: [{ ...buildOptions("x").vectorCollections[0], ids: ["doc-001", "doc-002", "doc-404"] }] }, "INVALID_ARGUMENT"],
    ["missing parquet", { tables: [{ ...buildOptions("x").tables[0], parquetPath: path.join(directory, "missing.parquet") }] }, "RESOURCE_NOT_FOUND"],
  ];
  for (const [label, overrides, code] of cases) {
    await assert.rejects(buildPackage(buildOptions(path.join(directory, label.replaceAll(" ", "-")), overrides)), { code }, label);
  }
  const leftovers = (await readdir(directory)).filter(name => name.includes(".staging-"));
  assert.deepEqual(leftovers, []);
});

test("validateIdMapContent enforces V1 offset and record rules", () => {
  const collection = { name: "c", count: 2, idMap: { uniqueIds: true } };
  const records = new TextEncoder().encode('{"row":0,"id":"a"}\n{"row":1,"id":"b"}\n');
  const valid = uint64([0, 19]);
  assert.equal(records.byteLength, 38);
  validateIdMapContent(collection, valid, records);

  assert.throws(() => validateIdMapContent(collection, uint64([1, 18]), records), { code: "RESOURCE_INTEGRITY_FAILED" });
  assert.throws(() => validateIdMapContent(collection, uint64([0, 999]), records), { code: "RESOURCE_INTEGRITY_FAILED" });
  assert.throws(() => validateIdMapContent(collection, uint64([0]), records), { code: "RESOURCE_INTEGRITY_FAILED" });

  const duplicate = new TextEncoder().encode('{"row":0,"id":"a"}\n{"row":1,"id":"a"}\n');
  assert.throws(() => validateIdMapContent(collection, valid, duplicate), { code: "RESOURCE_INTEGRITY_FAILED" });

  const brokenRow = new TextEncoder().encode('{"row":0,"id":"a"}\n{"row":7,"id":"b"}\n');
  assert.throws(() => validateIdMapContent(collection, valid, brokenRow), { code: "RESOURCE_INTEGRITY_FAILED" });

  const empty = { name: "c", count: 0, idMap: { uniqueIds: true } };
  validateIdMapContent(empty, new Uint8Array(), new Uint8Array());
  assert.throws(() => validateIdMapContent(empty, new Uint8Array(), records), { code: "RESOURCE_INTEGRITY_FAILED" });
});

test("the committed example fixture matches its own Manifest", async () => {
  const manifest = JSON.parse(await readFile(path.join(FIXTURE, "manifest.json"), "utf8"));
  const reader = new NodeFileResourceReader({ rootDirectory: FIXTURE });
  const report = await verifyManifestResources({ manifest, reader, options: { mode: "all" } });
  assert.equal(report.hashesVerified, 4);
  const hits = await open({ manifest, resourceReader: reader, verifyChecksums: "all" }).then(async db => {
    const result = await db.vector.search("document_embeddings", [1, 0], { topK: 2 });
    await db.close();
    return result;
  });
  assert.deepEqual(hits.map(hit => hit.id), ["doc-001", "doc-002"]);
});

test("Builder refuses to publish into the working directory", async () => {
  await assert.rejects(buildPackage(buildOptions(process.cwd())), { code: "INVALID_ARGUMENT" });
});

