import assert from "node:assert/strict";
import test from "node:test";

import { opfsDatabaseFileName } from "../dist/opfs.js";

const table = (name, bytes, sha256) => ({
  name,
  file: { path: `data/${name}.parquet`, bytes, sha256 },
  format: "parquet",
  columns: [],
});

const manifest = (tables, formatVersion = "1.0.0") => ({
  format: "weisql",
  formatVersion,
  datasetId: "test",
  tables,
  vectorCollections: [],
});

test("OPFS database name is stable, order-independent and content-sensitive", async () => {
  const a = manifest([table("b", 10, "b".repeat(64)), table("a", 5, "a".repeat(64))]);
  const b = manifest([table("a", 5, "a".repeat(64)), table("b", 10, "b".repeat(64))]);
  const key = await opfsDatabaseFileName(a);
  assert.match(key, /^weisql-[0-9a-f]{32}\.db$/);
  assert.equal(await opfsDatabaseFileName(b), key);

  // A different hash or size must not reuse the cached database.
  assert.notEqual(await opfsDatabaseFileName(manifest([table("a", 5, "c".repeat(64)), table("b", 10, "b".repeat(64))])), key);
  assert.notEqual(await opfsDatabaseFileName(manifest([table("a", 6, "a".repeat(64)), table("b", 10, "b".repeat(64))])), key);
  // A different format version is a different cache entry too.
  assert.notEqual(await opfsDatabaseFileName(manifest(a.tables, "2.0.0")), key);
});
