/**
 * Writes a deterministic synthetic package for the browser benchmarks.
 *
 * The rows are intentionally random-looking (hex ids, random scores) so Parquet
 * cannot compress them into something unrepresentative. The manifest carries the
 * real SHA-256, so the page can open with `verifyChecksums: "all"`.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { parquetWriteBuffer } from "hyparquet-writer";

const HEX = "0123456789abcdef";
const CATEGORIES = ["alpha", "beta", "gamma", "delta"];

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeParquet(rows) {
  const random = mulberry32(rows);
  const ids = new Array(rows);
  const categories = new Array(rows);
  const scores = new Array(rows);
  for (let index = 0; index < rows; index += 1) {
    let id = "";
    for (let character = 0; character < 32; character += 1) id += HEX[Math.floor(random() * 16)];
    ids[index] = id;
    categories[index] = CATEGORIES[Math.floor(random() * CATEGORIES.length)];
    scores[index] = random();
  }
  return new Uint8Array(parquetWriteBuffer({
    columnData: [
      { name: "id", type: "STRING", data: ids },
      { name: "category", type: "STRING", data: categories },
      { name: "score", type: "DOUBLE", data: scores },
    ],
  }));
}

export async function writeBenchPackage(directory, rows = 200_000) {
  const bytes = makeParquet(rows);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest = {
    format: "weisql",
    formatVersion: "1.0.0",
    datasetId: `browser-bench-${rows}`,
    tables: [{
      name: "documents",
      file: { path: "data/documents.parquet", bytes: bytes.byteLength, sha256 },
      format: "parquet",
      columns: [
        { name: "id", type: "string", nullable: false },
        { name: "category", type: "string", nullable: false },
        { name: "score", type: "float64", nullable: false },
      ],
      primaryKey: ["id"],
    }],
    vectorCollections: [],
  };
  await mkdir(path.join(directory, "data"), { recursive: true });
  await writeFile(path.join(directory, "data", "documents.parquet"), bytes);
  await writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { rows, parquetBytes: bytes.byteLength, sha256 };
}
