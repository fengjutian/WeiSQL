import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { open } from "../dist/index.js";

const TERMS = [
  { term: "dna", postings: [[0, 1], [2, 1]] },
  { term: "replication", postings: [[2, 1]] },
  { term: "rna", postings: [[1, 1]] },
  { term: "structure", postings: [[0, 1]] },
  { term: "transcription", postings: [[1, 1]] },
];
const IDS = ["doc-001", "doc-002", "doc-003"];
const DOC_LENGTHS = [2, 2, 2];
const SHA = "0".repeat(64);

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

class MemoryReader {
  constructor(files) { this.files = files; this.closed = false; }
  async read(path) { return this.files.get(path).slice(); }
  async readRange(path, range) { return this.files.get(path).slice(range.start, range.end); }
  async stat(path) { return { size: this.files.get(path).byteLength }; }
  async close() { this.closed = true; }
}

/** Builds a package whose Manifest declares one text index over `documents.data`. */
async function textPackage() {
  const manifest = JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
  const encoder = new TextEncoder();

  const termLines = TERMS.map(entry => encoder.encode(`${JSON.stringify({ term: entry.term, df: entry.postings.length, postings: entry.postings })}\n`));
  const termBytes = termLines.reduce((sum, line) => sum + line.byteLength, 0);
  const termData = new Uint8Array(termBytes);
  const termOffsets = [];
  let position = 0;
  for (const line of termLines) {
    termOffsets.push(position);
    termData.set(line, position);
    position += line.byteLength;
  }

  const idLines = IDS.map((id, row) => encoder.encode(`${JSON.stringify({ row, id })}\n`));
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
    ["text/terms.jsonl", termData],
    ["text/terms.offsets", u64(termOffsets)],
    ["text/doclengths.bin", u32(DOC_LENGTHS)],
    ["text/ids.jsonl", idData],
    ["text/ids.offsets", u64(idOffsets)],
  ]);

  manifest.textIndexes = [{
    name: "documents_text",
    tableName: "documents",
    column: "content",
    idColumn: "id",
    documentCount: IDS.length,
    termCount: TERMS.length,
    averageDocumentLength: DOC_LENGTHS.reduce((sum, value) => sum + value, 0) / DOC_LENGTHS.length,
    data: { path: "text/terms.jsonl", bytes: termData.byteLength, sha256: SHA },
    termOffsets: { path: "text/terms.offsets", bytes: files.get("text/terms.offsets").byteLength, sha256: SHA },
    docLengths: { path: "text/doclengths.bin", bytes: files.get("text/doclengths.bin").byteLength, sha256: SHA },
    idMap: {
      data: { path: "text/ids.jsonl", format: "jsonl", bytes: idData.byteLength, sha256: SHA },
      offsets: { path: "text/ids.offsets", format: "uint64-le", bytes: files.get("text/ids.offsets").byteLength, sha256: SHA },
      count: IDS.length,
      uniqueIds: true,
    },
  }];
  return { manifest, reader: new MemoryReader(files) };
}

test("exposes text search through the public Runtime", async () => {
  const { manifest, reader } = await textPackage();
  const db = await open({ manifest, resourceReader: reader });
  assert.equal(db.capabilities().textSearch, true);

  const hits = await db.text.search("documents_text", "dna", { topK: 5 });
  assert.deepEqual(hits.map(hit => hit.id), ["doc-001", "doc-003"]);
  assert.equal(hits[0].diagnostics.backend, "text-bm25");
  assert.ok(hits[0].score > 0);

  // Searching twice reuses the same reader and still ranks stably.
  const again = await db.text.search("documents_text", "DNA");
  assert.deepEqual(again.map(hit => hit.id), hits.map(hit => hit.id));
  await db.close();
});

test("unknown text indexes are reported and absent indexes disable the capability", async () => {
  const { manifest, reader } = await textPackage();
  const db = await open({ manifest, resourceReader: reader });
  await assert.rejects(db.text.search("missing_text", "dna"), { code: "INDEX_NOT_FOUND" });
  await db.close();

  const withoutText = JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
  const plain = await open({ manifest: withoutText, resourceReader: new MemoryReader(new Map()) });
  assert.equal(plain.capabilities().textSearch, false);
  await assert.rejects(plain.text.search("documents_text", "dna"), { code: "INDEX_NOT_FOUND" });
  await plain.close();
});

test("text search honours cancellation and lifecycle", async () => {
  const { manifest, reader } = await textPackage();
  const db = await open({ manifest, resourceReader: reader });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(db.text.search("documents_text", "dna", { signal: controller.signal }), { code: "QUERY_CANCELLED" });

  await db.close();
  assert.equal(db.state, "CLOSED");
  assert.equal(reader.closed, true);
  await assert.rejects(db.text.search("documents_text", "dna"), { code: "DATABASE_CLOSED" });
});
