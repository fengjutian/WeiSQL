import assert from "node:assert/strict";
import test from "node:test";

import { TextIndexReader } from "../dist/index.js";

const IDS = ["doc-001", "doc-002", "doc-003"];
const DOC_LENGTHS = [2, 2, 2];

const TERMS = [
  { term: "dna", postings: [[0, 1], [2, 1]] },
  { term: "replication", postings: [[2, 1]] },
  { term: "rna", postings: [[1, 1]] },
  { term: "structure", postings: [[0, 1]] },
  { term: "transcription", postings: [[1, 1]] },
];

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

function encoder() {
  return new TextEncoder();
}

/** Builds the three index files plus an ID map, mirroring the generator output. */
function buildIndex({ terms = TERMS, ids = IDS, docLengths = DOC_LENGTHS } = {}) {
  const lines = terms.map(entry => encoder().encode(`${JSON.stringify({ term: entry.term, df: entry.postings.length, postings: entry.postings })}\n`));
  const dataBytes = lines.reduce((sum, line) => sum + line.byteLength, 0);
  const data = new Uint8Array(dataBytes);
  const offsets = [];
  let position = 0;
  for (const line of lines) {
    offsets.push(position);
    data.set(line, position);
    position += line.byteLength;
  }

  const idLines = ids.map((id, row) => encoder().encode(`${JSON.stringify({ row, id })}\n`));
  const idBytes = idLines.reduce((sum, line) => sum + line.byteLength, 0);
  const idData = new Uint8Array(idBytes);
  const idOffsets = [];
  let idPosition = 0;
  for (const line of idLines) {
    idOffsets.push(idPosition);
    idData.set(line, idPosition);
    idPosition += line.byteLength;
  }

  const files = new Map([
    ["text/terms.jsonl", data],
    ["text/terms.offsets", u64(offsets)],
    ["text/doclengths.bin", u32(docLengths)],
    ["text/ids.jsonl", idData],
    ["text/ids.offsets", u64(idOffsets)],
  ]);

  const descriptor = {
    name: "documents_text",
    tableName: "documents",
    column: "content",
    idColumn: "id",
    documentCount: ids.length,
    termCount: terms.length,
    averageDocumentLength: docLengths.reduce((sum, value) => sum + value, 0) / docLengths.length,
    data: { path: "text/terms.jsonl", bytes: data.byteLength, sha256: "0".repeat(64) },
    termOffsets: { path: "text/terms.offsets", bytes: files.get("text/terms.offsets").byteLength, sha256: "0".repeat(64) },
    docLengths: { path: "text/doclengths.bin", bytes: files.get("text/doclengths.bin").byteLength, sha256: "0".repeat(64) },
    idMap: {
      data: { path: "text/ids.jsonl", format: "jsonl", bytes: idData.byteLength, sha256: "0".repeat(64) },
      offsets: { path: "text/ids.offsets", format: "uint64-le", bytes: files.get("text/ids.offsets").byteLength, sha256: "0".repeat(64) },
      count: ids.length,
      uniqueIds: true,
    },
  };
  return { descriptor, files };
}

function reader(files) {
  return {
    async readRange(path, range) {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`unexpected path ${path}`);
      return bytes.slice(range.start, range.end);
    },
    async read(path) { return files.get(path).slice(); },
    async stat(path) { return { size: files.get(path).byteLength }; },
    async close() {},
  };
}

test("ranks documents by BM25 and resolves business IDs", async () => {
  const { descriptor, files } = buildIndex();
  const index = new TextIndexReader(reader(files), descriptor);
  const hits = await index.search("dna", { topK: 10 });
  assert.deepEqual(hits.map(hit => hit.id), ["doc-001", "doc-003"]);
  assert.deepEqual(hits.map(hit => hit.row), [0, 2]);
  assert.ok(hits[0].score > 0);
  assert.equal(hits[0].diagnostics.backend, "text-bm25");
  await index.close();
});

test("documents matching more query terms rank higher", async () => {
  const { descriptor, files } = buildIndex();
  const index = new TextIndexReader(reader(files), descriptor);
  const hits = await index.search("dna replication", { topK: 10 });
  assert.equal(hits[0].id, "doc-003");
  assert.equal(hits[1].id, "doc-001");
  await index.close();
});

test("applies the tokenizer to the query", async () => {
  const { descriptor, files } = buildIndex();
  const index = new TextIndexReader(reader(files), descriptor);
  const upper = await index.search("DNA!", { topK: 10 });
  const lower = await index.search("dna", { topK: 10 });
  assert.deepEqual(upper.map(hit => hit.id), lower.map(hit => hit.id));
  await index.close();
});

test("returns nothing for unknown or empty queries", async () => {
  const { descriptor, files } = buildIndex();
  const index = new TextIndexReader(reader(files), descriptor);
  assert.deepEqual(await index.search("gibberish", { topK: 10 }), []);
  assert.deepEqual(await index.search("   ", { topK: 10 }), []);
  await index.close();
});

test("honours topK and rejects invalid values", async () => {
  const { descriptor, files } = buildIndex();
  const index = new TextIndexReader(reader(files), descriptor);
  assert.equal((await index.search("dna", { topK: 1 })).length, 1);
  await assert.rejects(index.search("dna", { topK: 0 }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(index.search("dna", { topK: 1.5 }), { code: "INVALID_ARGUMENT" });
  await index.close();
});

test("rejects corrupt postings and out-of-range rows", async () => {
  const badDf = buildIndex({ terms: [{ term: "dna", postings: [[0, 1], [2, 1]] }] });
  // df is derived from postings length, so corrupt it by shrinking the array the
  // descriptor expects: termCount 2 but only one line.
  badDf.descriptor.termCount = 2;
  await assert.rejects(new TextIndexReader(reader(badDf.files), badDf.descriptor).search("dna", { topK: 5 }), { code: "RESOURCE_INTEGRITY_FAILED" });

  const outOfRange = buildIndex({ terms: [{ term: "dna", postings: [[9, 1]] }], docLengths: [2, 2, 2] });
  await assert.rejects(new TextIndexReader(reader(outOfRange.files), outOfRange.descriptor).search("dna", { topK: 5 }), { code: "RESOURCE_INTEGRITY_FAILED" });
});

test("cancellation and close are respected", async () => {
  const { descriptor, files } = buildIndex();
  const index = new TextIndexReader(reader(files), descriptor);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(index.search("dna", { topK: 5, signal: controller.signal }), { code: "QUERY_CANCELLED" });
  await index.close();
  await assert.rejects(index.search("dna", { topK: 5 }), { code: "DATABASE_CLOSED" });
});
