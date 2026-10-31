import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { compileFilter } from "../dist/index.js";

async function fixture(extraColumns) {
  const manifest = JSON.parse(await readFile(new URL("../../../examples/manifest/valid-minimal.json", import.meta.url), "utf8"));
  const table = manifest.tables[0];
  if (extraColumns !== undefined) table.columns = table.columns.concat(extraColumns);
  return { table, vector: manifest.vectorCollections[0] };
}

async function compile(filter, extraColumns) {
  const { table, vector } = await fixture(extraColumns);
  return compileFilter(table, vector, filter);
}

test("compiles equality, membership and null conditions", async () => {
  const equality = await compile({ content: "alpha" });
  assert.match(equality.sql, /WHERE "content" = \?$/);
  assert.deepEqual(equality.parameters, ["alpha"]);

  const membership = await compile({ content: ["alpha", "beta"] });
  assert.match(membership.sql, /"content" IN \(\?, \?\)/);
  assert.deepEqual(membership.parameters, ["alpha", "beta"]);

  const explicit = await compile({ content: { in: ["gamma"] } });
  assert.match(explicit.sql, /"content" IN \(\?\)/);

  const missing = await compile({ content: null });
  assert.match(missing.sql, /"content" IS NULL/);
  assert.deepEqual(missing.parameters, []);
});

test("compiles range and inequality conditions on declared types", async () => {
  const columns = [
    { name: "score", type: "float64", nullable: false },
    { name: "rank", type: "int32", nullable: false },
    { name: "published", type: "date", nullable: false },
    { name: "created_at", type: "timestamp", nullable: false },
  ];

  const range = await compile({ score: { gte: 1.5, lt: 9 } }, columns);
  assert.match(range.sql, /"score" >= \? AND "score" < \?/);
  assert.deepEqual(range.parameters, [1.5, 9]);

  const notEqual = await compile({ rank: { ne: 3 } }, columns);
  assert.match(notEqual.sql, /"rank" <> \?/);
  assert.deepEqual(notEqual.parameters, [3]);

  // Fields are compiled in sorted order, so created_at precedes published.
  const dates = await compile({ published: new Date("2026-10-31T12:00:00Z"), created_at: { gte: "2026-01-01T00:00:00Z" } }, columns);
  assert.match(dates.sql, /"created_at" >= \? AND "published" = \?/);
  assert.deepEqual(dates.parameters, ["2026-01-01T00:00:00Z", "2026-10-31"]);

  const stringRange = await compile({ published: { gte: "2026-01-01" } }, columns);
  assert.match(stringRange.sql, /"published" >= \?/);
  assert.deepEqual(stringRange.parameters, ["2026-01-01"]);
});

test("rejects ambiguous, unsafe or unsupported conditions", async () => {
  await assert.rejects(compile({ content: [] }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(compile({ content: [null] }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(compile({ content: { in: [] } }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(compile({ content: { in: ["a"], ne: "b" } }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(compile({ content: { ne: null } }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(compile({ content: { gte: "a", gt: "b" } }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(compile({ content: { gt: "a", between: "b" } }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(compile({ content: {} }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(compile({ missing_column: "x" }), { code: "INVALID_ARGUMENT" });
  // JSON equality needs a canonical form; guessing one would silently match nothing.
  await assert.rejects(compile({ meta: "{}" }, [{ name: "meta", type: "json", nullable: false }]), { code: "INVALID_ARGUMENT" });
  // Date values are only meaningful for date/timestamp columns.
  await assert.rejects(compile({ content: new Date() }), { code: "INVALID_ARGUMENT" });
  await assert.rejects(compile({ content: 1 }), { code: "INVALID_ARGUMENT" });
});
