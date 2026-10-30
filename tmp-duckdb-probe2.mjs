import { DuckDBInstance } from "@duckdb/node-api";

const file = "D:/github/WeiSQL/examples/source/documents.parquet";
const literal = file.replace(/'/g, "''");

// A: view over parquet after disabling external access
{
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  await conn.run(`CREATE VIEW v AS SELECT * FROM read_parquet('${literal}')`);
  console.log("A) view query before disable:", JSON.stringify(await (await conn.runAndReadAll("SELECT count(*)::INTEGER AS c FROM v")).getRowObjectsJS()));
  await conn.run("SET enable_external_access=false");
  try {
    await conn.runAndReadAll("SELECT count(*)::INTEGER AS c FROM v");
    console.log("A) view still readable after disable");
  } catch (error) {
    console.log("A) view FAILS after disable ->", String(error.message).slice(0, 80));
  }
  conn.closeSync(); instance.closeSync();
}

// B: interrupt a genuinely long query
{
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  const started = Date.now();
  const pending = conn.runAndReadAll("SELECT sum(range) AS s FROM range(5000000000)");
  setTimeout(() => conn.interrupt(), 100);
  try {
    const reader = await pending;
    console.log("B) completed despite interrupt:", JSON.stringify(await reader.getRowObjectsJS()), `${Date.now() - started}ms`);
  } catch (error) {
    console.log(`B) interrupted after ${Date.now() - started}ms ->`, String(error.message).slice(0, 100));
  }
  // connection usable afterwards?
  try {
    const after = await conn.runAndReadAll("SELECT 1 AS ok");
    console.log("B) connection reusable after interrupt:", JSON.stringify(await after.getRowObjectsJS()));
  } catch (error) {
    console.log("B) connection broken after interrupt ->", String(error.message).slice(0, 100));
  }
  conn.closeSync(); instance.closeSync();
}

// C: prepared statement rejects multiple statements
{
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  for (const sql of ["select 1", "select 1; select 2", "select 1; drop table x"]) {
    try {
      const statement = await conn.prepare(sql);
      console.log(`C) prepare "${sql}" -> OK (type ${statement.statementType})`);
      statement.destroySync();
    } catch (error) {
      console.log(`C) prepare "${sql}" -> rejected: ${String(error.message).slice(0, 70)}`);
    }
  }
  conn.closeSync(); instance.closeSync();
}

