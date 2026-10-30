import { DuckDBInstance } from "@duckdb/node-api";

const file = "D:/github/WeiSQL/examples/source/documents.parquet";
const literal = file.replace(/'/g, "''");
const instance = await DuckDBInstance.create(":memory:");
const conn = await instance.connect();

try {
  await conn.run("CREATE TABLE documents AS SELECT * FROM read_parquet(?)", [file]);
  console.log("1) CTAS with bound parameter: OK");
} catch (error) {
  console.log("1) CTAS with bound parameter: FAILED ->", String(error.message).slice(0, 120));
  await conn.run(`CREATE TABLE documents AS SELECT * FROM read_parquet('${literal}')`);
  console.log("   CTAS with literal: OK");
}

const described = await conn.runAndReadAll("DESCRIBE documents");
console.log("2) DESCRIBE ->", JSON.stringify(await described.getRowObjectsJS()));

const typed = await conn.runAndReadAll(`SELECT
  9223372036854775807::BIGINT AS big, 1::INTEGER AS i, 1.5::DOUBLE AS d, 1.5::FLOAT AS f,
  TIMESTAMP '2024-01-01 12:00:00' AS ts, DATE '2024-01-01' AS dt, NULL::VARCHAR AS n,
  BLOB 'abc' AS b, 3.25::DECIMAL(10,2) AS dec, true AS bo, gen_random_uuid()::UUID AS u`);
const row = (await typed.getRowObjectsJS())[0];
console.log("3) JS value mapping:");
for (const [key, value] of Object.entries(row)) {
  const ctor = value && typeof value === "object" ? value.constructor.name : "";
  console.log(`   ${key.padEnd(4)} typeof=${typeof value} ctor=${ctor} value=${String(value)}`);
}

try {
  await conn.run("SET enable_external_access=false");
  const counted = await conn.runAndReadAll("SELECT count(*)::INTEGER AS c FROM documents");
  console.log("4) query after enable_external_access=false:", JSON.stringify(await counted.getRowObjectsJS()));
} catch (error) {
  console.log("4) enable_external_access=false FAILED ->", String(error.message).slice(0, 140));
}

try {
  await conn.runAndReadAll(`SELECT count(*) FROM read_parquet('${literal}')`);
  console.log("5) read_parquet still allowed AFTER disable (boundary hole)");
} catch (error) {
  console.log("5) read_parquet blocked after disable ->", String(error.message).slice(0, 90));
}

try {
  await conn.run("SET lock_configuration=true");
  console.log("6) lock_configuration: OK");
} catch (error) {
  console.log("6) lock_configuration FAILED ->", String(error.message).slice(0, 90));
}

try {
  const extracted = await conn.extractStatements("select 1; select 2");
  console.log("7) extractStatements('select 1; select 2').count =", extracted.count);
} catch (error) {
  console.log("7) extractStatements FAILED ->", String(error.message).slice(0, 90));
}

const slow = conn.runAndReadAll("SELECT sum(i) AS s FROM range(2000000000)");
setTimeout(() => conn.interrupt(), 60);
try {
  await slow;
  console.log("8) interrupt: query completed anyway");
} catch (error) {
  console.log("8) interrupt: query aborted ->", String(error.message).slice(0, 80));
}

try {
  const readOnly = await DuckDBInstance.create(":memory:", { access_mode: "read_only" });
  await readOnly.connect();
  console.log("9) :memory: read_only: OK");
} catch (error) {
  console.log("9) :memory: read_only FAILED ->", String(error.message).slice(0, 90));
}

try {
  await conn.run("CREATE TABLE t2 AS SELECT 1 AS x");
  console.log("10) DDL after lock_configuration: ALLOWED (expected, boundary is API-level)");
} catch (error) {
  console.log("10) DDL after lock:", String(error.message).slice(0, 90));
}

conn.closeSync();
instance.closeSync();
