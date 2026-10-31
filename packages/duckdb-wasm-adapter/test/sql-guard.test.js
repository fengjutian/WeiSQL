import assert from "node:assert/strict";
import test from "node:test";

import { assertReadOnlyStatement, containsSecondStatement, leadingKeyword } from "../dist/index.js";

test("leadingKeyword skips comments and whitespace", () => {
  assert.equal(leadingKeyword("  select 1"), "SELECT");
  assert.equal(leadingKeyword("-- hello\nEXPLAIN SELECT 1"), "EXPLAIN");
  assert.equal(leadingKeyword("/* hi */ describe documents"), "DESCRIBE");
  assert.equal(leadingKeyword("-- only a comment"), "");
  assert.equal(leadingKeyword("/* unterminated"), "");
});

test("accepts read-only statement verbs", () => {
  for (const statement of ["SELECT 1", "EXPLAIN SELECT 1", "DESCRIBE documents", "SHOW TABLES", "SUMMARIZE documents", "TABLE documents", "VALUES (1)"]) {
    assert.doesNotThrow(() => assertReadOnlyStatement(statement), statement);
  }
});

test("rejects writes, DDL and configuration changes", () => {
  for (const statement of [
    "INSERT INTO documents VALUES (1)",
    "UPDATE documents SET id = 1",
    "DELETE FROM documents",
    "CREATE TABLE x AS SELECT 1",
    "DROP TABLE documents",
    "ALTER TABLE documents ADD COLUMN x INT",
    "COPY documents TO '/tmp/x.parquet'",
    "ATTACH 'x.db'",
    "SET enable_external_access=true",
    "PRAGMA database_list",
    "CALL pragma_version()",
    "LOAD parquet",
    "INSTALL parquet",
  ]) {
    assert.throws(() => assertReadOnlyStatement(statement), (error) => error.code === "SQL_UNSUPPORTED", statement);
  }
});

test("rejects CTEs explicitly, because they would bypass a keyword filter", () => {
  assert.throws(
    () => assertReadOnlyStatement("WITH x AS (SELECT 1) DELETE FROM documents"),
    (error) => error.code === "SQL_UNSUPPORTED" && /CTEs/.test(error.message),
  );
});

test("rejects empty input", () => {
  assert.throws(() => assertReadOnlyStatement("   "), (error) => error.code === "INVALID_ARGUMENT");
  assert.throws(() => assertReadOnlyStatement("-- nothing\n"), (error) => error.code === "SQL_UNSUPPORTED");
});

test("detects a second statement but not semicolons inside literals", () => {
  assert.equal(containsSecondStatement("SELECT 1; SELECT 2"), true);
  assert.equal(containsSecondStatement("SELECT ';'"), false);
  assert.equal(containsSecondStatement('SELECT ";" FROM documents'), false);
  assert.equal(containsSecondStatement("SELECT 1; -- trailing comment"), false);
  assert.equal(containsSecondStatement("SELECT 1; /* trailing */"), false);
  assert.equal(containsSecondStatement("SELECT 1;\n\t"), false);
  assert.equal(containsSecondStatement("SELECT $$;$tag$$"), false);
  assert.equal(containsSecondStatement("SELECT 'it''s; fine'"), false);
  assert.equal(containsSecondStatement("SELECT 1; SELECT 2; SELECT 3"), true);
});
