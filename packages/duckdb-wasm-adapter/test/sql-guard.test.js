import assert from "node:assert/strict";
import test from "node:test";

import { assertReadOnlyStatement, byteOffsetsToIndices, classifyWithTokens, containsSecondStatement, leadingKeyword } from "../dist/index.js";

/** Builds the offsets/types shape DuckDB's tokenizer returns for simple SQL. */
function streamFor(parts) {
  return {
    offsets: parts.map(([offset]) => offset),
    types: parts.map(([, type]) => type),
  };
}

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

test("rejects CTEs when the tokenizer is unavailable", () => {
  assert.throws(
    () => assertReadOnlyStatement("WITH x AS (SELECT 1) SELECT * FROM x"),
    (error) => error.code === "SQL_UNSUPPORTED" && /CTEs/.test(error.message),
  );
});

test("classifies a CTE list and reads the verb that follows it", () => {
  const source = "WITH x AS (SELECT 1) SELECT 1";
  const tokens = streamFor([[0, 4], [5, 0], [7, 4], [10, 3], [11, 4], [18, 1], [19, 3], [21, 4], [28, 1]]);
  assert.equal(classifyWithTokens(source, tokens), "SELECT");
  assert.equal(assertReadOnlyStatement(source, tokens), "SELECT");
});

test("rejects a CTE whose statement is a write", () => {
  const source = "WITH x AS (SELECT 1) DELETE FROM documents";
  const tokens = streamFor([[0, 4], [5, 0], [7, 4], [10, 3], [11, 4], [18, 1], [19, 3], [21, 4], [28, 4], [33, 0]]);
  assert.throws(() => classifyWithTokens(source, tokens), (error) => error.code === "SQL_UNSUPPORTED");
});

test("fails closed on an unrecognised or unbalanced CTE list", () => {
  const unbalanced = "WITH x AS (SELECT 1 SELECT 1";
  assert.throws(
    () => classifyWithTokens(unbalanced, streamFor([[0, 4], [5, 0], [7, 4], [10, 3], [11, 4], [18, 1], [20, 4], [27, 1]])),
    (error) => error.code === "SQL_UNSUPPORTED",
  );
});

test("translates UTF-8 byte offsets before slicing", () => {
  const sql = "SELECT '中' AS s";
  // DuckDB reports bytes: AS starts at byte 13, which is index 11 in JS.
  assert.deepEqual(byteOffsetsToIndices(sql, [0, 7, 13, 16]), [0, 7, 11, 14]);
  const cte = "WITH x AS (SELECT '中') SELECT 1";
  assert.deepEqual(byteOffsetsToIndices(cte, [0, 5, 7, 10, 11, 18, 23, 25, 32]), [0, 5, 7, 10, 11, 18, 21, 23, 30]);
  assert.equal(
    classifyWithTokens(cte, {
      offsets: [0, 5, 7, 10, 11, 18, 23, 25, 32],
      types: [4, 0, 4, 3, 4, 2, 3, 4, 1],
    }),
    "SELECT",
  );
});

test("detects a second statement from tokens, including a trailing semicolon", () => {
  const one = "SELECT 1;";
  const oneTokens = streamFor([[0, 4], [7, 1], [8, 3]]);
  assert.equal(classifyWithTokens(one, oneTokens), "SELECT");
  const two = "SELECT 1; SELECT 2";
  const twoTokens = streamFor([[0, 4], [7, 1], [8, 3], [10, 4], [17, 1]]);
  assert.throws(() => classifyWithTokens(two, twoTokens), (error) => error.code === "SQL_UNSUPPORTED");
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
