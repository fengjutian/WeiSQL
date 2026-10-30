/**
 * Builds a V1 full-text index for one text column and records it in the Manifest.
 *
 *   node tools/build-text-index.mjs <package-dir> --table documents --column title
 *        [--name documents_text] [--min-length 1] [--k1 1.2] [--b 0.75]
 *
 * Reads the Parquet column with hyparquet (a dev-only reader), tokenizes with the
 * SDK's own tokenizer, writes the index files and re-validates the Manifest before
 * saving. Run `weisql validate <package-dir>` afterwards as the publish gate.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { parquetReadObjects } from "hyparquet";

import { sha256Hex, tokenize, validateManifest } from "@weisql/sdk";

const encoder = new TextEncoder();

function parse(argv) {
  const options = { directory: undefined, table: undefined, column: undefined, name: undefined, minLength: 1, k1: undefined, b: undefined };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--table": options.table = value; index++; break;
      case "--column": options.column = value; index++; break;
      case "--name": options.name = value; index++; break;
      case "--min-length": options.minLength = Number(value); index++; break;
      case "--k1": options.k1 = Number(value); index++; break;
      case "--b": options.b = Number(value); index++; break;
      default:
        if (flag.startsWith("--")) throw new Error(`unknown option ${flag}`);
        if (options.directory !== undefined) throw new Error(`unexpected argument ${flag}`);
        options.directory = flag;
    }
  }
  if (options.directory === undefined) throw new Error("usage: node tools/build-text-index.mjs <package-dir> --table <name> --column <name>");
  if (options.table === undefined || options.column === undefined) throw new Error("--table and --column are required");
  options.name ??= `${options.table}_${options.column}_text`;
  return options;
}

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

function descriptorOf(relative, bytes) {
  return { path: relative, bytes: bytes.byteLength, sha256: sha256Hex(bytes) };
}

const options = parse(process.argv.slice(2));
const directory = path.resolve(options.directory);
const manifestPath = path.join(directory, "manifest.json");
const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));

const table = manifest.tables.find(item => item.name === options.table);
if (table === undefined) throw new Error(`table not found: ${options.table}`);
const column = table.columns.find(item => item.name === options.column);
if (column === undefined) throw new Error(`column not found: ${options.column}`);
if (column.type !== "string" && column.type !== "json") throw new Error(`column ${options.column} is not a text column (${column.type})`);
const idColumn = table.primaryKey[0];
if (idColumn === undefined) throw new Error(`table ${options.table} has no primary key`);

const parquetBytes = new Uint8Array(await readFile(path.join(directory, table.file.path)));
const rows = await parquetReadObjects({ file: parquetBytes.buffer.slice(parquetBytes.byteOffset, parquetBytes.byteOffset + parquetBytes.byteLength) });
if (rows.length === 0) throw new Error("table has no rows");

const terms = new Map();
const docLengths = [];
const ids = [];
const idLines = [];
const idOffsets = [];
const documentLines = [];
const documentOffsets = [];
let idBytes = 0;
let documentBytes = 0;

for (let row = 0; row < rows.length; row++) {
  const record = rows[row];
  const text = record[options.column];
  if (text !== null && text !== undefined && typeof text !== "string") throw new Error(`row ${row}: column is not text`);
  const value = typeof text === "string" ? text : "";
  const tokens = tokenize(value, { minLength: options.minLength });
  docLengths.push(tokens.length);
  for (const token of tokens) {
    let postings = terms.get(token);
    if (postings === undefined) {
      postings = new Map();
      terms.set(token, postings);
    }
    postings.set(row, (postings.get(row) ?? 0) + 1);
  }

  const id = record[idColumn];
  if (typeof id !== "string" && !(typeof id === "number" && Number.isSafeInteger(id))) {
    throw new Error(`row ${row}: primary key value is not a string or safe integer`);
  }
  ids.push(id);
  const line = encoder.encode(`${JSON.stringify({ row, id })}\n`);
  idOffsets.push(idBytes);
  idBytes += line.byteLength;
  idLines.push(line);

  const documentLine = encoder.encode(`${JSON.stringify({ row, text: value })}\n`);
  documentOffsets.push(documentBytes);
  documentBytes += documentLine.byteLength;
  documentLines.push(documentLine);
}

const averageDocumentLength = docLengths.reduce((sum, value) => sum + value, 0) / docLengths.length;
if (!(averageDocumentLength > 0)) throw new Error("every document is empty; a BM25 index over an empty column is useless");

const sortedTerms = [...terms.keys()].sort();
const termLines = sortedTerms.map(term => {
  const postings = [...terms.get(term).entries()].sort((left, right) => left[0] - right[0]);
  return encoder.encode(`${JSON.stringify({ term, df: postings.length, postings })}\n`);
});
const termData = new Uint8Array(termLines.reduce((sum, line) => sum + line.byteLength, 0));
const termOffsets = [];
{
  let position = 0;
  for (const line of termLines) {
    termOffsets.push(position);
    termData.set(line, position);
    position += line.byteLength;
  }
}

const idData = new Uint8Array(idBytes);
{
  let position = 0;
  for (const line of idLines) {
    idData.set(line, position);
    position += line.byteLength;
  }
}

const documentData = new Uint8Array(documentBytes);
{
  let position = 0;
  for (const line of documentLines) {
    documentData.set(line, position);
    position += line.byteLength;
  }
}

const base = `text-index/${options.name}`;
const files = new Map([
  [`${base}.terms.jsonl`, termData],
  [`${base}.terms.offsets`, u64(termOffsets)],
  [`${base}.doclengths.bin`, u32(docLengths)],
  [`${base}.ids.jsonl`, idData],
  [`${base}.ids.offsets`, u64(idOffsets)],
  [`${base}.documents.jsonl`, documentData],
  [`${base}.documents.offsets`, u64(documentOffsets)],
]);

await mkdir(path.join(directory, "text-index"), { recursive: true });
for (const [relative, bytes] of files) {
  await writeFile(path.join(directory, ...relative.split("/")), bytes);
}

const entry = {
  name: options.name,
  tableName: options.table,
  column: options.column,
  idColumn,
  documentCount: rows.length,
  termCount: sortedTerms.length,
  averageDocumentLength,
  data: descriptorOf(`${base}.terms.jsonl`, termData),
  termOffsets: descriptorOf(`${base}.terms.offsets`, u64(termOffsets)),
  docLengths: descriptorOf(`${base}.doclengths.bin`, u32(docLengths)),
  idMap: {
    data: { ...descriptorOf(`${base}.ids.jsonl`, idData), format: "jsonl" },
    offsets: { ...descriptorOf(`${base}.ids.offsets`, u64(idOffsets)), format: "uint64-le" },
    count: ids.length,
    uniqueIds: new Set(ids).size === ids.length,
  },
  documents: {
    data: { ...descriptorOf(`${base}.documents.jsonl`, documentData), format: "jsonl" },
    offsets: { ...descriptorOf(`${base}.documents.offsets`, u64(documentOffsets)), format: "uint64-le" },
  },
  ...(options.k1 === undefined ? {} : { k1: options.k1 }),
  ...(options.b === undefined ? {} : { b: options.b }),
};

manifest.textIndexes = [...(manifest.textIndexes ?? []).filter(item => item.name !== options.name), entry];
validateManifest(manifest);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(JSON.stringify({
  package: directory,
  textIndex: options.name,
  table: options.table,
  column: options.column,
  documents: rows.length,
  terms: sortedTerms.length,
  averageDocumentLength: Number(averageDocumentLength.toFixed(3)),
  bytes: {
    terms: termData.byteLength,
    termOffsets: files.get(`${base}.terms.offsets`).byteLength,
    docLengths: files.get(`${base}.doclengths.bin`).byteLength,
    ids: idData.byteLength,
    documents: documentData.byteLength,
  },
  sampleTerms: sortedTerms.slice(0, 5),
  next: "weisql validate <package-dir>",
}, null, 2));
