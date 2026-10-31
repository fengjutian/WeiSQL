import assert from "node:assert/strict";
import test from "node:test";

import { opfsDatabaseFileName, selectOpfsEvictions } from "../dist/opfs.js";

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

test("OPFS eviction keeps the current database and the newest others", () => {
  const base = (suffix) => `weisql-${suffix.padStart(32, "0")}.db`;
  const entries = [
    { name: base("1"), lastModified: 1 },
    { name: `${base("1")}.wal`, lastModified: 1 },
    { name: base("2"), lastModified: 2 },
    { name: `${base("2")}.wal`, lastModified: 2 },
    { name: base("3"), lastModified: 3 },
    { name: base("4"), lastModified: 4 },
    { name: base("5"), lastModified: 5 },
    { name: "unrelated.txt", lastModified: 9 },
  ];
  // Keep the current file plus the three newest others: 2 and its WAL go.
  assert.deepEqual(
    selectOpfsEvictions(entries, base("1"), 4).sort(),
    [`${base("2")}.wal`, base("2")].sort(),
  );
  // Keeping the newest evicts the oldest and its WAL.
  assert.deepEqual(
    selectOpfsEvictions(entries, base("5"), 4).sort(),
    [`${base("1")}.wal`, base("1")].sort(),
  );
  // A budget of one leaves only the current database.
  assert.equal(selectOpfsEvictions(entries, base("3"), 1).length, 6);
  // Files that are not our databases are never touched.
  assert.ok(!selectOpfsEvictions(entries, base("1"), 4).includes("unrelated.txt"));
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
