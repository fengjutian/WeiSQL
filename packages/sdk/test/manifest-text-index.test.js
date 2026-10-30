import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { declaredResources, validateManifest } from "../dist/index.js";

const SHA = "a".repeat(64);

async function baseManifest() {
  return JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
}

function textIndex(overrides = {}) {
  return {
    name: "documents_text",
    tableName: "documents",
    column: "content",
    idColumn: "id",
    documentCount: 3,
    termCount: 5,
    averageDocumentLength: 12.5,
    data: { path: "text-index/documents.terms.jsonl", bytes: 512, sha256: SHA },
    termOffsets: { path: "text-index/documents.terms.offsets", bytes: 40, sha256: SHA },
    docLengths: { path: "text-index/documents.doclengths.bin", bytes: 12, sha256: SHA },
    idMap: {
      data: { path: "text-index/documents.ids.jsonl", format: "jsonl", bytes: 75, sha256: SHA },
      offsets: { path: "text-index/documents.ids.offsets", format: "uint64-le", bytes: 24, sha256: SHA },
      count: 3,
      uniqueIds: true,
    },
    ...overrides,
  };
}

async function manifestWith(index) {
  const manifest = await baseManifest();
  manifest.textIndexes = [index];
  return manifest;
}

test("accepts a text index over a string column", async () => {
  const parsed = validateManifest(await manifestWith(textIndex()));
  assert.equal(parsed.textIndexes?.[0].name, "documents_text");
  assert.equal(parsed.textIndexes?.[0].documentCount, 3);
  assert.equal(parsed.textIndexes?.[0].k1, undefined);
});

test("accepts explicit BM25 parameters", async () => {
  const parsed = validateManifest(await manifestWith(textIndex({ k1: 1.5, b: 0.5 })));
  assert.equal(parsed.textIndexes?.[0].k1, 1.5);
  assert.equal(parsed.textIndexes?.[0].b, 0.5);
});

test("rejects BM25 parameters outside their domains", async () => {
  for (const patch of [{ k1: 0 }, { k1: -1 }, { b: -0.1 }, { b: 1.5 }]) {
    assert.throws(() => validateManifest(manifestWith(textIndex(patch))), () => true, JSON.stringify(patch));
    const manifest = await manifestWith(textIndex(patch));
    assert.throws(() => validateManifest(manifest), { code: "MANIFEST_INVALID" }, JSON.stringify(patch));
  }
});

test("rejects unknown tables, unknown columns and non-key id columns", async () => {
  const cases = [
    { tableName: "missing" },
    { column: "missing_column" },
    { idColumn: "content" },       // declared, but not part of the primary key
  ];
  for (const patch of cases) {
    const manifest = await manifestWith(textIndex(patch));
    assert.throws(() => validateManifest(manifest), { code: "MANIFEST_INVALID" }, JSON.stringify(patch));
  }
});

test("rejects non-text column types", async () => {
  const manifest = await baseManifest();
  manifest.tables[0].columns[1].type = "int32";
  manifest.textIndexes = [textIndex()];
  assert.throws(() => validateManifest(manifest), { code: "MANIFEST_INVALID" });
});

test("rejects offset and doc-length byte counts that disagree with the counts", async () => {
  const badOffsets = await manifestWith(textIndex({ termOffsets: { path: "text-index/documents.terms.offsets", bytes: 32, sha256: SHA } }));
  assert.throws(() => validateManifest(badOffsets), { code: "MANIFEST_INVALID" });

  const badLengths = await manifestWith(textIndex({ docLengths: { path: "text-index/documents.doclengths.bin", bytes: 8, sha256: SHA } }));
  assert.throws(() => validateManifest(badLengths), { code: "MANIFEST_INVALID" });
});

test("rejects empty indexes and duplicate names", async () => {
  for (const patch of [{ documentCount: 0 }, { termCount: 0 }, { averageDocumentLength: 0 }]) {
    const manifest = await manifestWith(textIndex(patch));
    assert.throws(() => validateManifest(manifest), { code: "MANIFEST_INVALID" }, JSON.stringify(patch));
  }

  const duplicate = await baseManifest();
  duplicate.textIndexes = [textIndex(), textIndex({ data: { path: "text-index/other.jsonl", bytes: 512, sha256: SHA } })];
  assert.throws(() => validateManifest(duplicate), { code: "MANIFEST_INVALID" });
});

test("rejects resource paths already declared elsewhere", async () => {
  const manifest = await manifestWith(textIndex({
    data: { path: "data/documents.parquet", bytes: 512, sha256: SHA },
  }));
  assert.throws(() => validateManifest(manifest), { code: "MANIFEST_INVALID" });
});

test("rejects unknown fields inside a text index", async () => {
  const manifest = await manifestWith(textIndex({ stopWords: ["the"] }));
  assert.throws(() => validateManifest(manifest), { code: "MANIFEST_INVALID" });
});

test("text indexes are optional", async () => {
  const parsed = validateManifest(await baseManifest());
  assert.equal(parsed.textIndexes, undefined);
});

test("text index files participate in L3 resource enumeration", async () => {
  const parsed = validateManifest(await manifestWith(textIndex()));
  const kinds = declaredResources(parsed).map(resource => `${resource.kind}:${resource.path}`);
  assert.ok(kinds.includes("text-data:text-index/documents.terms.jsonl"));
  assert.ok(kinds.includes("text-offsets:text-index/documents.terms.offsets"));
  assert.ok(kinds.includes("text-lengths:text-index/documents.doclengths.bin"));
  assert.ok(kinds.includes("text-ids:text-index/documents.ids.jsonl"));
  assert.ok(kinds.includes("text-id-offsets:text-index/documents.ids.offsets"));
});

test("accepts optional document text and checks its offsets", async () => {
  const withDocuments = await manifestWith(textIndex({
    documents: {
      data: { path: "text-index/documents.documents.jsonl", format: "jsonl", bytes: 120, sha256: SHA },
      offsets: { path: "text-index/documents.documents.offsets", format: "uint64-le", bytes: 24, sha256: SHA },
    },
  }));
  const parsed = validateManifest(withDocuments);
  assert.equal(parsed.textIndexes?.[0].documents?.data.path, "text-index/documents.documents.jsonl");
  const kinds = declaredResources(parsed).map(resource => resource.kind);
  assert.ok(kinds.includes("text-documents") && kinds.includes("text-document-offsets"));

  const badOffsets = await manifestWith(textIndex({
    documents: {
      data: { path: "text-index/documents.documents.jsonl", format: "jsonl", bytes: 120, sha256: SHA },
      offsets: { path: "text-index/documents.documents.offsets", format: "uint64-le", bytes: 40, sha256: SHA },
    },
  }));
  assert.throws(() => validateManifest(badOffsets), { code: "MANIFEST_INVALID" });

  const badFormat = await manifestWith(textIndex({
    documents: {
      data: { path: "text-index/documents.documents.jsonl", format: "uint64-le", bytes: 120, sha256: SHA },
      offsets: { path: "text-index/documents.documents.offsets", format: "uint64-le", bytes: 24, sha256: SHA },
    },
  }));
  assert.throws(() => validateManifest(badFormat), { code: "MANIFEST_INVALID" });
});

test("text id map must agree with the document count", async () => {  const badCount = await manifestWith(textIndex({
    idMap: {
      data: { path: "text-index/documents.ids.jsonl", format: "jsonl", bytes: 75, sha256: SHA },
      offsets: { path: "text-index/documents.ids.offsets", format: "uint64-le", bytes: 16, sha256: SHA },
      count: 2,
      uniqueIds: true,
    },
  }));
  assert.throws(() => validateManifest(badCount), { code: "MANIFEST_INVALID" });

  const badOffsets = await manifestWith(textIndex({
    idMap: {
      data: { path: "text-index/documents.ids.jsonl", format: "jsonl", bytes: 75, sha256: SHA },
      offsets: { path: "text-index/documents.ids.offsets", format: "uint64-le", bytes: 40, sha256: SHA },
      count: 3,
      uniqueIds: true,
    },
  }));
  assert.throws(() => validateManifest(badOffsets), { code: "MANIFEST_INVALID" });
});
