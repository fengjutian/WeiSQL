import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { open } from "../dist/index.js";

const ROWS = 512;
const DIMENSION = 4;

function floats(values) {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return bytes;
}

function u64(values) {
  const bytes = new Uint8Array(values.length * 8);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setBigUint64(index * 8, BigInt(value), true));
  return bytes;
}

/** Counts bytes per path so a test can prove the scan stayed selective. */
class CountingReader {
  constructor(files) { this.files = files; this.bytesByPath = new Map(); this.readsByPath = new Map(); }
  async read(path) { return this.readRange(path, { start: 0, end: this.files.get(path).byteLength }); }
  async readRange(path, range) {
    const bytes = this.files.get(path).slice(range.start, range.end);
    this.bytesByPath.set(path, (this.bytesByPath.get(path) ?? 0) + bytes.byteLength);
    this.readsByPath.set(path, (this.readsByPath.get(path) ?? 0) + 1);
    return bytes;
  }
  async stat(path) { return { size: this.files.get(path).byteLength, supportsRange: true }; }
  async close() {}
}

const IDS = Array.from({ length: ROWS }, (_, row) => `r${String(row).padStart(3, "0")}`);

function fakeSqlAdapter(ids) {
  return {
    capabilities: { engine: "fake", parameterBinding: true, parquet: true, supportedFeatures: [], cancellation: "native" },
    async open() {},
    async query() { return ids.map(id => ({ id })); },
    async close() {},
  };
}

async function packageWithRows() {
  const manifest = JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
  const collection = manifest.vectorCollections[0];
  collection.count = ROWS;
  collection.dimension = DIMENSION;

  const vectorBytes = floats(Array.from({ length: ROWS }, (_, row) => [1, row / ROWS, 0, 0]).flat());
  const idLines = IDS.map((id, row) => new TextEncoder().encode(`${JSON.stringify({ row, id })}\n`));
  const idData = new Uint8Array(idLines.reduce((sum, line) => sum + line.byteLength, 0));
  const idOffsets = [];
  let position = 0;
  for (const line of idLines) {
    idOffsets.push(position);
    idData.set(line, position);
    position += line.byteLength;
  }

  collection.data.bytes = vectorBytes.byteLength;
  collection.data.sha256 = "0".repeat(64);
  collection.idMap.count = ROWS;
  collection.idMap.data.bytes = idData.byteLength;
  collection.idMap.data.sha256 = "0".repeat(64);
  collection.idMap.offsets.bytes = ROWS * 8;
  collection.idMap.offsets.sha256 = "0".repeat(64);

  const reader = new CountingReader(new Map([
    [collection.data.path, vectorBytes],
    [collection.idMap.data.path, idData],
    [collection.idMap.offsets.path, u64(idOffsets)],
  ]));
  return { manifest, collection, reader };
}

test("a selective filter reads only the allowed vector rows", async () => {
  const { manifest, collection, reader } = await packageWithRows();
  const allowedIds = [...IDS.slice(0, 8), ...IDS.slice(100, 104)];
  const db = await open({ manifest, resourceReader: reader, sqlAdapter: fakeSqlAdapter(allowedIds) });

  const hits = await db.vector.search(collection.name, [1, 0, 0, 0], { topK: 3, filter: { content: "selected" } });
  assert.deepEqual(hits.map(hit => hit.id), ["r000", "r001", "r002"]);

  // Two contiguous runs (8 + 4 rows) at 16 bytes each: no full-file scan.
  assert.equal(reader.bytesByPath.get(collection.data.path), 12 * DIMENSION * 4);
  assert.equal(reader.readsByPath.get(collection.data.path), 2);
  assert.ok(reader.bytesByPath.get(collection.data.path) < collection.data.bytes / 4);
  await db.close();
});

test("a broad filter still streams the file sequentially", async () => {
  const { manifest, collection, reader } = await packageWithRows();
  // 256 of 512 rows: above the 1/8 threshold, so the sequential path is used.
  const allowedIds = IDS.slice(0, 256);
  const db = await open({ manifest, resourceReader: reader, sqlAdapter: fakeSqlAdapter(allowedIds) });

  const hits = await db.vector.search(collection.name, [1, 0, 0, 0], { topK: 2, filter: { content: "selected" } });
  assert.deepEqual(hits.map(hit => hit.id), ["r000", "r001"]);
  assert.equal(reader.bytesByPath.get(collection.data.path), collection.data.bytes);
  await db.close();
});
