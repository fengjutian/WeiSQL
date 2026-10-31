import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { parquetReadObjects } from "hyparquet";

import { validatePackage } from "../dist/index.js";
import { convertSource } from "../../../tools/source-to-parquet.mjs";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const TOOL = path.join(REPO_ROOT, "tools", "source-to-parquet.mjs");

async function readBack(bytes) {
  return parquetReadObjects({ file: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
}

/** Writes converted Parquet plus a Builder-style Manifest for L4 validation. */
async function writePackage(directory, converted, datasetId) {
  await mkdir(path.join(directory, "data"), { recursive: true });
  await writeFile(path.join(directory, "data", "documents.parquet"), converted.parquet);
  const manifest = {
    format: "weisql",
    formatVersion: "1.0.0",
    datasetId,
    tables: [{
      name: "documents",
      file: {
        path: "data/documents.parquet",
        bytes: converted.parquet.byteLength,
        sha256: createHash("sha256").update(converted.parquet).digest("hex"),
      },
      format: "parquet",
      columns: converted.columns,
      primaryKey: ["id"],
    }],
    vectorCollections: [],
  };
  await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

test("converts CSV with quotes, commas and empty cells", async () => {
  const csv = 'id,title,rating,active\ndoc-001,"DNA, structure",4.5,true\ndoc-002,RNA,3,false\ndoc-003,,5,true\n';
  const converted = convertSource(csv, "csv");
  assert.equal(converted.rows, 3);
  assert.deepEqual(converted.columns, [
    { name: "id", type: "string", nullable: false },
    { name: "title", type: "string", nullable: true },
    { name: "rating", type: "float64", nullable: false },
    { name: "active", type: "boolean", nullable: false },
  ]);

  const rows = await readBack(converted.parquet);
  assert.deepEqual(rows, [
    { id: "doc-001", title: "DNA, structure", rating: 4.5, active: true },
    { id: "doc-002", title: "RNA", rating: 3, active: false },
    { id: "doc-003", title: null, rating: 5, active: true },
  ]);
});

test("keeps CSV identifiers with leading zeros as strings", async () => {
  const csv = "code,count\n001,1\n002,2\n";
  const converted = convertSource(csv, "csv");
  assert.deepEqual(converted.columns, [
    { name: "code", type: "string", nullable: false },
    { name: "count", type: "int32", nullable: false },
  ]);
  const rows = await readBack(converted.parquet);
  assert.deepEqual(rows.map(row => row.code), ["001", "002"]);
});

test("infers JSON types, including int64 and nullability", async () => {
  const jsonl = [
    { id: "a", big: 8_000_000_000, ratio: 0.5, ok: true },
    { id: "b", big: 9_000_000_000, ratio: 1.5, ok: false },
    { id: "c", big: null, ratio: 2, ok: true },
  ].map(row => JSON.stringify(row)).join("\n");
  const converted = convertSource(jsonl, "json");
  assert.deepEqual(converted.columns, [
    { name: "id", type: "string", nullable: false },
    { name: "big", type: "int64", nullable: true },
    { name: "ratio", type: "float64", nullable: false },
    { name: "ok", type: "boolean", nullable: false },
  ]);
  const rows = await readBack(converted.parquet);
  assert.equal(rows[0].big, 8_000_000_000n);
  assert.equal(rows[2].big, null);
});

test("explicit --timestamp columns become Parquet timestamps", async () => {
  const rows = [
    { id: "a", created: "2024-01-01T12:00:00Z" },
    { id: "b", created: "2024-01-02T08:30:00+08:00" },
  ];
  const converted = convertSource(JSON.stringify(rows), "json", { timestampColumns: ["created"] });
  assert.deepEqual(converted.columns, [
    { name: "id", type: "string", nullable: false },
    { name: "created", type: "timestamp", nullable: false },
  ]);
  const read = await readBack(converted.parquet);
  assert.ok(read[0].created instanceof Date);
  assert.equal(read[0].created.toISOString(), "2024-01-01T12:00:00.000Z");
  assert.equal(read[1].created.toISOString(), "2024-01-02T00:30:00.000Z");
});

test("rejects timestamp columns whose values are not strict ISO 8601", () => {
  assert.throws(
    () => convertSource(JSON.stringify([{ ts: "2024-01-01" }]), "json", { timestampColumns: ["ts"] }),
    /not ISO 8601 with an offset/,
  );
});

test("converts nested JSON objects and arrays into a json column", async () => {
  const rows = [
    { id: "a", meta: { tags: ["x", "y"], score: 1 } },
    { id: "b", meta: { tags: [] } },
    { id: "c", meta: null },
  ];
  const converted = convertSource(JSON.stringify(rows), "json");
  assert.deepEqual(converted.columns, [
    { name: "id", type: "string", nullable: false },
    { name: "meta", type: "json", nullable: true },
  ]);
  const read = await readBack(converted.parquet);
  assert.deepEqual(read[0].meta, { tags: ["x", "y"], score: 1 });
  assert.deepEqual(read[1].meta, { tags: [] });
  assert.equal(read[2].meta, null);
});

test("rejects mixing nested JSON with scalar values", () => {
  assert.throws(
    () => convertSource(JSON.stringify([{ meta: { a: 1 } }, { meta: "text" }]), "json"),
    /mixes incompatible types/,
  );
});

test("a nested JSON column survives Builder-style Manifest and L4 validation", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "weisql-json-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const converted = convertSource(JSON.stringify([
    { id: "a", meta: { tags: ["x"] } },
    { id: "b", meta: { tags: [] } },
  ]), "json");
  await writePackage(directory, converted, "nested-json");

  const result = await validatePackage({ directory, l4: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.l4, { ok: true, tables: 1 });
});

test("an explicit timestamp column survives L4 validation", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "weisql-timestamp-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const converted = convertSource(JSON.stringify([
    { id: "a", created: "2024-01-01T12:00:00Z" },
    { id: "b", created: "2024-01-02T08:30:00+08:00" },
  ]), "json", { timestampColumns: ["created"] });
  await writePackage(directory, converted, "timestamp-column");

  const result = await validatePackage({ directory, l4: true });
  assert.equal(result.ok, true);
  assert.deepEqual(result.l4, { ok: true, tables: 1 });
});

test("rejects mixed-type columns and bad input", () => {
  assert.throws(() => convertSource('[{"a":1},{"a":"x"}]', "json"), /mixes incompatible types/);
  assert.throws(() => convertSource("[]", "json"), /no rows/);
  assert.throws(() => convertSource("a,b\n", "csv"), /no rows/);
});

test("CLI writes a Parquet file and reports Manifest column types", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "weisql-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = path.join(directory, "rows.jsonl");
  const output = path.join(directory, "rows.parquet");
  await writeFile(input, '{"id":"a","score":1.5}\n{"id":"b","score":2.5}\n', "utf8");

  const { stdout } = await run(process.execPath, [TOOL, input, "--output", output]);
  const summary = JSON.parse(stdout);
  assert.equal(summary.rows, 2);
  assert.deepEqual(summary.columns, [
    { name: "id", type: "string", nullable: false },
    { name: "score", type: "float64", nullable: false },
  ]);

  const rows = await readBack(new Uint8Array(await readFile(output)));
  assert.deepEqual(rows, [{ id: "a", score: 1.5 }, { id: "b", score: 2.5 }]);
});
