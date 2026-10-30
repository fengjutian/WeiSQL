import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { open, reciprocalRankFusion } from "../dist/index.js";

const SHA = "0".repeat(64);
const TERMS = [
  { term: "dna", postings: [[0, 1], [2, 1]] },
  { term: "replication", postings: [[2, 1]] },
  { term: "rna", postings: [[1, 1]] },
  { term: "structure", postings: [[0, 1]] },
  { term: "transcription", postings: [[1, 1]] },
];
const IDS = ["doc-001", "doc-002", "doc-003"];

function u64(values) {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setBigUint64(index * 8, BigInt(value), true));
  return bytes;
}

function u32(values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value, true));
  return bytes;
}

function floats(values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

class MemoryReader {
  constructor(files) { this.files = files; this.closed = false; }
  async read(path) { return this.files.get(path).slice(); }
  async readRange(path, range) { return this.files.get(path).slice(range.start, range.end); }
  async stat(path) { return { size: this.files.get(path).byteLength }; }
  async close() { this.closed = true; }
}

/** Package with both a vector collection and one text index over the same rows. */
async function hybridPackage() {
  const manifest = JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
  const encoder = new TextEncoder();

  const idData = encoder.encode('{"row":0,"id":"doc-001"}\n{"row":1,"id":"doc-002"}\n{"row":2,"id":"doc-003"}\n');

  const termLines = TERMS.map(entry => encoder.encode(`${JSON.stringify({ term: entry.term, df: entry.postings.length, postings: entry.postings })}\n`));
  const termData = new Uint8Array(termLines.reduce((sum, line) => sum + line.byteLength, 0));
  const termOffsets = [];
  let position = 0;
  for (const line of termLines) {
    termOffsets.push(position);
    termData.set(line, position);
    position += line.byteLength;
  }

  const TEXTS = ["DNA 结构", "RNA 转录", "细胞代谢"];
  const documentLines = TEXTS.map((text, row) => encoder.encode(`${JSON.stringify({ row, text })}\n`));
  const documentData = new Uint8Array(documentLines.reduce((sum, line) => sum + line.byteLength, 0));
  const documentOffsets = [];
  let documentPosition = 0;
  for (const line of documentLines) {
    documentOffsets.push(documentPosition);
    documentData.set(line, documentPosition);
    documentPosition += line.byteLength;
  }

  const files = new Map([
    ["vectors/embeddings.f32", floats([1, 0, 0.9, 0.1, 0, 1])],
    ["vectors/id-map.jsonl", idData],
    ["vectors/id-map.offsets", u64([0, 25, 50])],
    ["text/terms.jsonl", termData],
    ["text/terms.offsets", u64(termOffsets)],
    ["text/doclengths.bin", u32([2, 2, 2])],
    ["text/ids.jsonl", idData],
    ["text/ids.offsets", u64([0, 25, 50])],
    ["text/documents.jsonl", documentData],
    ["text/documents.offsets", u64(documentOffsets)],
  ]);

  manifest.textIndexes = [{
    name: "documents_text",
    tableName: "documents",
    column: "content",
    idColumn: "id",
    documentCount: IDS.length,
    termCount: TERMS.length,
    averageDocumentLength: 2,
    data: { path: "text/terms.jsonl", bytes: termData.byteLength, sha256: SHA },
    termOffsets: { path: "text/terms.offsets", bytes: files.get("text/terms.offsets").byteLength, sha256: SHA },
    docLengths: { path: "text/doclengths.bin", bytes: 12, sha256: SHA },
    idMap: {
      data: { path: "text/ids.jsonl", format: "jsonl", bytes: idData.byteLength, sha256: SHA },
      offsets: { path: "text/ids.offsets", format: "uint64-le", bytes: 24, sha256: SHA },
      count: IDS.length,
      uniqueIds: true,
    },
    documents: {
      data: { path: "text/documents.jsonl", format: "jsonl", bytes: documentData.byteLength, sha256: SHA },
      offsets: { path: "text/documents.offsets", format: "uint64-le", bytes: documentOffsets.length * 8, sha256: SHA },
    },
  }];
  return { manifest, reader: new MemoryReader(files) };
}

test("rrf scores by rank and breaks ties by best rank", () => {
  const fused = reciprocalRankFusion([
    { name: "vector", ids: ["a", "b"] },
    { name: "text", ids: ["b", "c"] },
  ], { k: 60, topK: 10 });
  assert.deepEqual(fused.map(hit => hit.id), ["b", "a", "c"]);
  const b = fused[0];
  assert.ok(Math.abs(b.score - (1 / 61 + 1 / 62)) < 1e-12);
  assert.deepEqual(b.ranks, { vector: 2, text: 1 });
  assert.ok(Math.abs(fused[1].score - 1 / 61) < 1e-12);
});

test("rrf keeps number and string ids distinct and honours topK", () => {
  const fused = reciprocalRankFusion([
    { name: "vector", ids: [1, "1"] },
  ], { topK: 1 });
  assert.equal(fused.length, 1);
  assert.equal(fused[0].id, 1);

  const smallK = reciprocalRankFusion([{ name: "a", ids: ["x"] }], { k: 1, topK: 5 });
  assert.ok(Math.abs(smallK[0].score - 0.5) < 1e-12);
  assert.throws(() => reciprocalRankFusion([], { topK: 0 }));
  assert.throws(() => reciprocalRankFusion([], { k: 0 }));
});

test("hybrid search fuses vector and text rankings through the Runtime", async () => {
  const { manifest, reader } = await hybridPackage();
  const db = await open({ manifest, resourceReader: reader });
  assert.equal(db.capabilities().fusionSearch, true);

  const hits = await db.hybrid.search({
    topK: 3,
    vector: { name: "document_embeddings", query: [1, 0] },
    text: { name: "documents_text", query: "dna" },
  });
  // doc-001 is first in both lists; doc-003 appears in both but lower; doc-002 only in vector.
  assert.deepEqual(hits.map(hit => hit.id), ["doc-001", "doc-003", "doc-002"]);
  assert.deepEqual(hits[0].ranks, { vector: 1, text: 1 });
  assert.equal(hits[0].diagnostics.backend, "rrf");
  assert.equal(hits[0].diagnostics.k, 60);
  assert.equal(hits[0].vector.distance, 0);
  assert.ok(hits[0].text.score > 0);
  assert.equal(hits[2].ranks.text, undefined);
  await db.close();
});

test("hybrid search works with a single source and validates its input", async () => {
  const { manifest, reader } = await hybridPackage();
  const db = await open({ manifest, resourceReader: reader });

  const textOnly = await db.hybrid.search({ text: { name: "documents_text", query: "dna" }, topK: 2 });
  assert.deepEqual(textOnly.map(hit => hit.id), ["doc-001", "doc-003"]);
  assert.equal(textOnly[0].vector, undefined);

  const vectorOnly = await db.hybrid.search({ vector: { name: "document_embeddings", query: [1, 0] }, topK: 1 });
  assert.equal(vectorOnly[0].id, "doc-001");

  await assert.rejects(db.hybrid.search({}), { code: "INVALID_ARGUMENT" });
  await assert.rejects(db.hybrid.search({ text: { name: "documents_text", query: "dna" }, topK: 0 }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(db.hybrid.search({ text: { name: "documents_text", query: "dna" }, k: 0 }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(db.hybrid.search({ text: { name: "missing", query: "dna" } }), { code: "INDEX_NOT_FOUND" });
  await assert.rejects(db.hybrid.search({ vector: { name: "missing", query: [1, 0] } }), { code: "INDEX_NOT_FOUND" });
  await db.close();
});

test("fusion capability and cancellation follow the instance state", async () => {
  const { manifest, reader } = await hybridPackage();
  const db = await open({ manifest, resourceReader: reader });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(db.hybrid.search({ text: { name: "documents_text", query: "dna" }, signal: controller.signal }), { code: "QUERY_CANCELLED" });
  await db.close();

  const plain = JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
  plain.vectorCollections = [];
  const bare = await open({ manifest: plain, resourceReader: new MemoryReader(new Map()) });
  assert.equal(bare.capabilities().fusionSearch, false);
  await bare.close();
});
