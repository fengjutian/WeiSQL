/**
 * Converts CSV or JSON rows into a Parquet file that the Builder can consume.
 *
 *   node tools/source-to-parquet.mjs data.csv --output data/documents.parquet
 *   node tools/source-to-parquet.mjs data.jsonl --output data/documents.parquet
 *
 * Deliberately a tool, not an SDK feature: the SDK stays dependency-free, and
 * `hyparquet-writer` is a root devDependency like `hyparquet` itself. The
 * printed summary lists the Manifest column types so the two cannot drift.
 *
 * Type inference is conservative:
 * - JSON keeps native types; mixed types in one column are an error.
 * - CSV only turns a value into a number when it round-trips exactly ("001" stays
 *   a string, "1" becomes an integer), and only recognizes "true"/"false".
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parquetWriteBuffer } from "hyparquet-writer";

/** Manifest column type for each Parquet type this tool emits. */
const MANIFEST_TYPE = {
  STRING: "string",
  INT32: "int32",
  INT64: "int64",
  DOUBLE: "float64",
  BOOLEAN: "boolean",
};

/** Parses RFC 4180 CSV: quoted fields, doubled quotes, CRLF, optional BOM. */
export function parseCsv(text) {
  const input = text.replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let index = 0;

  const endField = () => {
    row.push(quoted ? field : field === "" ? null : field);
    field = "";
    quoted = false;
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== null) rows.push(row);
    row = [];
  };

  while (index < input.length) {
    const character = input[index];
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index++;
        continue;
      }
      field += character;
      index++;
      continue;
    }
    if (character === '"') {
      quoted = true;
      index++;
      continue;
    }
    if (character === ",") {
      endField();
      index++;
      continue;
    }
    if (character === "\r") {
      index++;
      continue;
    }
    if (character === "\n") {
      endRow();
      index++;
      continue;
    }
    field += character;
    index++;
  }
  if (field !== "" || row.length > 0 || quoted) endRow();

  const header = rows.shift();
  if (header === undefined) throw new Error("CSV is empty");
  if (header.some(name => name === null || name === "")) throw new Error("CSV header contains an empty column name");
  return { header, rows: rows.map(values => Object.fromEntries(header.map((name, position) => [name, values[position] ?? null]))) };
}

/** Accepts a JSON array of objects or newline-delimited JSON objects. */
export function parseJsonRows(text) {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (trimmed === "") throw new Error("JSON input is empty");
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) throw new Error("JSON input must be an array of objects");
    return parsed;
  }
  return trimmed.split(/\r?\n/).filter(line => line.trim() !== "").map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (cause) {
      throw new Error(`JSONL line ${index + 1} is not valid JSON: ${String(cause)}`);
    }
  });
}

/** CSV values are strings; convert only when the conversion is lossless. */
function coerceCsvValue(value) {
  if (value === null) return null;
  if (/^-?\d+$/.test(value) && String(Number(value)) === value) return Number(value);
  if (/^-?\d+\.\d+$/.test(value) && String(Number(value)) === value) return Number(value);
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}

function inferColumn(name, values) {
  const present = values.filter(value => value !== null && value !== undefined);
  const nullable = present.length !== values.length;
  if (present.length === 0) return { name, type: "STRING", nullable: true };

  if (present.every(value => typeof value === "boolean")) return { name, type: "BOOLEAN", nullable };
  if (present.every(value => typeof value === "number" && Number.isFinite(value))) {
    if (present.every(value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647)) return { name, type: "INT32", nullable };
    if (present.every(value => Number.isSafeInteger(value))) return { name, type: "INT64", nullable };
    return { name, type: "DOUBLE", nullable };
  }
  if (present.every(value => typeof value === "string")) return { name, type: "STRING", nullable };
  throw new Error(`column '${name}' mixes incompatible types: ${[...new Set(present.map(value => typeof value))].join(", ")}`);
}

/** Builds the Parquet buffer plus the Manifest column declarations. */
export function convertRows(rows, options = {}) {
  if (rows.length === 0) throw new Error("input has no rows");
  if (!rows.every(row => typeof row === "object" && row !== null && !Array.isArray(row))) throw new Error("every row must be an object");

  const names = [...new Set(rows.flatMap(row => Object.keys(row)))];
  if (names.length === 0) throw new Error("input has no columns");
  const columns = names.map(name => inferColumn(name, rows.map(row => (name in row ? row[name] : null))));

  const buffer = parquetWriteBuffer({
    columnData: columns.map(column => {
      const values = rows.map(row => (row[column.name] === undefined ? null : row[column.name]));
      // hyparquet-writer requires BigInt for INT64 and rejects plain numbers.
      const data = column.type === "INT64" ? values.map(value => (typeof value === "number" ? BigInt(value) : value)) : values;
      return {
        name: column.name,
        type: column.type,
        data,
        nullable: column.nullable,
      };
    }),
    ...(options.codec === undefined ? {} : { codec: options.codec }),
    createdBy: `weisql-source-to-parquet/1`,
  });

  return {
    parquet: new Uint8Array(buffer),
    rows: rows.length,
    columns: columns.map(column => ({ name: column.name, type: MANIFEST_TYPE[column.type], nullable: column.nullable })),
  };
}

export function convertSource(text, format) {
  const rows = format === "csv" ? (() => {
    const { rows: parsed } = parseCsv(text);
    return parsed.map(row => Object.fromEntries(Object.entries(row).map(([name, value]) => [name, coerceCsvValue(value)])));
  })() : parseJsonRows(text);
  return convertRows(rows);
}

function parseArguments(argv) {
  const options = { input: undefined, output: undefined, format: undefined };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--output") { options.output = value; index++; continue; }
    if (argument === "--format") {
      if (value !== "csv" && value !== "json") throw new Error("--format must be 'csv' or 'json'");
      options.format = value;
      index++;
      continue;
    }
    if (argument.startsWith("--")) throw new Error(`unknown option ${argument}`);
    if (options.input !== undefined) throw new Error(`unexpected argument ${argument}`);
    options.input = argument;
  }
  if (options.input === undefined || options.output === undefined) throw new Error("usage: node tools/source-to-parquet.mjs <input.csv|input.json|input.jsonl> --output <file.parquet>");
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const extension = path.extname(options.input).toLowerCase();
  const format = options.format ?? (extension === ".csv" ? "csv" : "json");
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(options.input, "utf8");
  const converted = convertSource(text, format);

  await writeFile(options.output, converted.parquet);
  console.log(JSON.stringify({
    input: options.input,
    output: options.output,
    format,
    rows: converted.rows,
    parquetBytes: converted.parquet.byteLength,
    columns: converted.columns,
  }, null, 2));
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
