import { readFile } from "node:fs/promises";
import { NodeFileResourceReader, open } from "@weisql/sdk";
import { createDuckDbAdapter } from "@weisql/duckdb-adapter";

const root = "examples/fixture";
const manifest = JSON.parse(await readFile(`${root}/manifest.json`, "utf8"));
const reader = new NodeFileResourceReader({ rootDirectory: root });
const adapter = createDuckDbAdapter();

const db = await open({ manifest, resourceReader: reader, sqlAdapter: adapter, verifyChecksums: "all" });
console.log("state:", db.state, "sql capability:", db.capabilities().sql);
console.log("adapter:", adapter.capabilities.engine, adapter.capabilities.engineVersion, adapter.capabilities.cancellation);

console.log("rows:", JSON.stringify(await db.sql("SELECT id, title, category FROM documents ORDER BY id")));
console.log("params:", JSON.stringify(await db.sql("SELECT id FROM documents WHERE id = ?", ["doc-002"])));
console.log("injection:", JSON.stringify(await db.sql("SELECT id FROM documents WHERE id = ?", ["doc-001' OR '1'='1"])));
const typed = await db.sql("SELECT 9223372036854775807::BIGINT AS big, TIMESTAMP '2024-01-01 12:00:00' AS ts, BLOB 'abc' AS b, 3.25::DECIMAL(10,2) AS dec, NULL::VARCHAR AS n");
const row = typed[0];
console.log("types:", Object.entries(row).map(([k, v]) => `${k}=${typeof v}${v instanceof Uint8Array ? "(Uint8Array)" : ""}`).join(" "));

for (const sql of ["INSERT INTO documents VALUES ('x','y','z')", "DROP TABLE documents", "CREATE TABLE x(a INT)", "SET threads=1", "select 1; select 2", "SELECT * FROM read_parquet('C:/Windows/win.ini')"]) {
  try {
    await db.sql(sql);
    console.log(`UNEXPECTED ALLOWED: ${sql}`);
  } catch (error) {
    console.log(`blocked [${error.code}] ${sql}`);
  }
}

const controller = new AbortController();
const started = Date.now();
const slow = db.sql("SELECT sum(range) AS s FROM range(5000000000)", [], { signal: controller.signal });
setTimeout(() => controller.abort(), 80);
try {
  await slow;
  console.log("cancellation: query completed (unexpected)");
} catch (error) {
  console.log(`cancellation: ${error.code} after ${Date.now() - started}ms`);
}

await db.close();
await db.close();
console.log("closed:", db.state);
try {
  await db.sql("SELECT 1");
} catch (error) {
  console.log("after close:", error.code);
}
