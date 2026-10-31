import { WeiSQLError } from "@weisql/sdk/errors";

/**
 * Statement keywords the browser adapter is willing to send to DuckDB-Wasm.
 *
 * Why an allow-list instead of DuckDB's own statement classification: the
 * DuckDB-Wasm JavaScript API exposes no `StatementType` for a prepared
 * statement (unlike `@duckdb/node-api`, which the Node adapter relies on). A
 * deny-list alone would be bypassable: `WITH x AS (...) DELETE FROM t` leads
 * with `WITH`, so it would slip past a keyword filter. The browser adapter
 * therefore refuses anything that does not start with one of the verbs below,
 * and that includes `WITH` itself 鈥?see docs/DUCKDB_WASM_ADAPTER.md.
 */
export const READ_ONLY_FIRST_KEYWORDS: ReadonlySet<string> = new Set([
  "SELECT",
  "EXPLAIN",
  "DESCRIBE",
  "SHOW",
  "SUMMARIZE",
  "PIVOT",
  "UNPIVOT",
  "TABLE",
  "VALUES",
]);

/**
 * Rejects statements that are not single, read-only queries.
 *
 * `WITH` is rejected with its own message because it is the one construct a
 * user is likely to reach for and the one that would otherwise be the obvious
 * bypass. Multiple statements are rejected by a scanner rather than by
 * splitting on `;`, so semicolons inside strings and comments do not count.
 */
export function assertReadOnlyStatement(statement: string): string {
  if (typeof statement !== "string" || statement.trim().length === 0) {
    throw new WeiSQLError("INVALID_ARGUMENT", "SQL statement must be a non-empty string");
  }
  const keyword = leadingKeyword(statement);
  if (keyword === "WITH") {
    throw new WeiSQLError("SQL_UNSUPPORTED", "CTEs (`WITH`) are not supported by the DuckDB-Wasm adapter", {
      engine: "duckdb-wasm",
      statementType: keyword,
    });
  }
  if (!READ_ONLY_FIRST_KEYWORDS.has(keyword)) {
    throw new WeiSQLError("SQL_UNSUPPORTED", "Only read-only statements (SELECT/EXPLAIN) are allowed", {
      engine: "duckdb-wasm",
      statementType: keyword === "" ? "UNKNOWN" : keyword,
    });
  }
  if (containsSecondStatement(statement)) {
    throw new WeiSQLError("SQL_UNSUPPORTED", "Only one SQL statement per query is allowed", {
      engine: "duckdb-wasm",
    });
  }
  return keyword;
}

/** First keyword after leading whitespace and SQL comments, upper-cased. */
export function leadingKeyword(statement: string): string {
  let rest = statement;
  for (;;) {
    rest = rest.replace(/^\s+/, "");
    if (rest.startsWith("--")) {
      const newline = rest.indexOf("\n");
      if (newline === -1) return "";
      rest = rest.slice(newline + 1);
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = rest.indexOf("*/");
      if (end === -1) return "";
      rest = rest.slice(end + 2);
      continue;
    }
    break;
  }
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
  return match === null ? "" : match[0].toUpperCase();
}

/**
 * True when a `;` is followed by anything other than whitespace or comments.
 *
 * The scanner understands single-quoted strings (with `''` escapes),
 * double-quoted identifiers, dollar-quoted strings, line comments and block
 * comments, because all of them may legally contain a semicolon.
 */
export function containsSecondStatement(statement: string): boolean {
  let index = 0;
  let sawTerminator = false;
  while (index < statement.length) {
    const char = statement[index]!;
    if (sawTerminator) {
      if (/\s/.test(char)) {
        index += 1;
        continue;
      }
      if (char === "-" && statement[index + 1] === "-") {
        index = skipLineComment(statement, index);
        continue;
      }
      if (char === "/" && statement[index + 1] === "*") {
        index = skipBlockComment(statement, index);
        continue;
      }
      // A second statement exists.
      return true;
    }
    if (char === "'") {
      index = skipQuoted(statement, index, "'");
      continue;
    }
    if (char === '"') {
      index = skipQuoted(statement, index, '"');
      continue;
    }
    if (char === "$") {
      const tag = dollarTag(statement, index);
      if (tag !== undefined) {
        index = skipDollarQuoted(statement, index, tag);
        continue;
      }
    }
    if (char === "-" && statement[index + 1] === "-") {
      index = skipLineComment(statement, index);
      continue;
    }
    if (char === "/" && statement[index + 1] === "*") {
      index = skipBlockComment(statement, index);
      continue;
    }
    if (char === ";") sawTerminator = true;
    index += 1;
  }
  return false;
}

function skipQuoted(text: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < text.length) {
    if (text[index] === quote) {
      if (text[index + 1] === quote) {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index += 1;
  }
  return text.length;
}

function skipLineComment(text: string, start: number): number {
  const newline = text.indexOf("\n", start);
  return newline === -1 ? text.length : newline + 1;
}

function skipBlockComment(text: string, start: number): number {
  const end = text.indexOf("*/", start + 2);
  return end === -1 ? text.length : end + 2;
}

function dollarTag(text: string, start: number): string | undefined {
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(start));
  return match === null ? undefined : match[0];
}

function skipDollarQuoted(text: string, start: number, tag: string): number {
  const end = text.indexOf(tag, start + tag.length);
  return end === -1 ? text.length : end + tag.length;
}
