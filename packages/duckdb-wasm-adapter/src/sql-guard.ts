import { WeiSQLError } from "@weisql/sdk/errors";

/**
 * Statement keywords the browser adapter is willing to send to DuckDB-Wasm.
 *
 * The allow-list is the fallback boundary. When the engine's tokenizer is
 * available the guard additionally understands `WITH`: it walks the CTE list
 * and classifies the statement that follows it, so `WITH ... SELECT` is allowed
 * while `WITH ... DELETE` is still rejected. Without tokens, `WITH` is refused
 * outright — see docs/DUCKDB_WASM_ADAPTER.md.
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

/** DuckDB's token types, as returned by `tokenize()`. */
const TOKEN_IDENTIFIER = 0;
const TOKEN_OPERATOR = 3;
const TOKEN_KEYWORD = 4;

/**
 * The token stream DuckDB returns: parallel arrays of byte offsets and token
 * types. Token text is recovered from the source between offsets, so comments
 * and whitespace never become part of a comparison.
 */
export interface SqlTokenStream {
  offsets: readonly number[];
  types: readonly number[];
}

interface Token {
  text: string;
  type: number;
}

/**
 * Rejects statements that are not single, read-only queries.
 *
 * With `tokens`, the classification uses DuckDB's own lexer, which is what makes
 * CTEs safe: the first keyword after the CTE list decides the statement type.
 * Without `tokens`, the stricter fallback applies and `WITH` is rejected.
 */
export function assertReadOnlyStatement(statement: string, tokens?: SqlTokenStream): string {
  if (typeof statement !== "string" || statement.trim().length === 0) {
    throw new WeiSQLError("INVALID_ARGUMENT", "SQL statement must be a non-empty string");
  }
  if (tokens !== undefined) return classifyWithTokens(statement, tokens);

  const keyword = leadingKeyword(statement);
  if (keyword === "WITH") {
    throw new WeiSQLError("SQL_UNSUPPORTED", "CTEs (`WITH`) require the DuckDB-Wasm tokenizer", {
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

/** Classifies a token stream and returns the statement verb. Fails closed. */
export function classifyWithTokens(statement: string, stream: SqlTokenStream): string {
  const tokens = readTokens(statement, stream);
  if (tokens.length === 0) {
    throw new WeiSQLError("SQL_UNSUPPORTED", "Only read-only statements (SELECT/EXPLAIN) are allowed", {
      engine: "duckdb-wasm",
      statementType: "UNKNOWN",
    });
  }
  for (let index = 0; index < tokens.length; index += 1) {
    if (isOperator(tokens[index], ";") && index < tokens.length - 1) {
      throw new WeiSQLError("SQL_UNSUPPORTED", "Only one SQL statement per query is allowed", {
        engine: "duckdb-wasm",
      });
    }
  }

  let index = 0;
  if (isKeyword(tokens[0], "WITH")) index = skipCteList(tokens, 1);
  const verb = tokens[index];
  if (verb === undefined || verb.type !== TOKEN_KEYWORD) throw unsupported(verb?.text);
  const upper = verb.text.toUpperCase();
  if (!READ_ONLY_FIRST_KEYWORDS.has(upper)) throw unsupported(upper);
  return upper;
}

function unsupported(verb: string | undefined): WeiSQLError {
  return new WeiSQLError("SQL_UNSUPPORTED", "Only read-only statements (SELECT/EXPLAIN) are allowed", {
    engine: "duckdb-wasm",
    statementType: verb === undefined || verb === "" ? "UNKNOWN" : verb.toUpperCase(),
  });
}

/**
 * Skips `[RECURSIVE] name [(cols)] [MATERIALIZED] AS ( body ) {, ...}` and
 * returns the index of the token that follows the CTE list. Any shape this does
 * not recognise is rejected rather than guessed.
 */
function skipCteList(tokens: readonly Token[], start: number): number {
  let index = start;
  if (isKeyword(tokens[index], "RECURSIVE")) index += 1;
  for (;;) {
    const name = tokens[index];
    if (name === undefined || (name.type !== TOKEN_IDENTIFIER && name.type !== TOKEN_KEYWORD)) throw unsupported(name?.text);
    index += 1;
    if (isOperator(tokens[index], "(")) index = skipBalanced(tokens, index);
    if (isKeyword(tokens[index], "MATERIALIZED")) index += 1;
    else if (isKeyword(tokens[index], "NOT") && isKeyword(tokens[index + 1], "MATERIALIZED")) index += 2;
    if (!isKeyword(tokens[index], "AS")) throw unsupported(tokens[index]?.text);
    index += 1;
    if (!isOperator(tokens[index], "(")) throw unsupported(tokens[index]?.text);
    index = skipBalanced(tokens, index);
    if (isOperator(tokens[index], ",")) {
      index += 1;
      continue;
    }
    return index;
  }
}

/** `start` must point at `(`; returns the index after the matching `)`. */
function skipBalanced(tokens: readonly Token[], start: number): number {
  let depth = 0;
  for (let index = start; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isOperator(token, "(")) depth += 1;
    else if (isOperator(token, ")")) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  throw unsupported("UNBALANCED");
}

function readTokens(statement: string, stream: SqlTokenStream): Token[] {
  const tokens: Token[] = [];
  // DuckDB reports UTF-8 byte offsets, not JavaScript string indices. Slicing
  // with them directly misreads every token that follows a non-ASCII character
  // (for example a Chinese literal), so they are translated first.
  const starts = byteOffsetsToIndices(statement, stream.offsets);
  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]!;
    const end = index + 1 < starts.length ? starts[index + 1]! : statement.length;
    const slice = statement.slice(start, end).trimStart();
    const type = stream.types[index] ?? -1;
    // Keywords and identifiers may be followed by a comment or whitespace that
    // the next offset does not skip, so only the leading word is the token.
    const text = type === TOKEN_KEYWORD || type === TOKEN_IDENTIFIER
      ? (/^[A-Za-z_][A-Za-z0-9_$]*/.exec(slice)?.[0] ?? "")
      : (slice[0] ?? "");
    tokens.push({ type, text });
  }
  return tokens;
}

/**
 * Translates UTF-8 byte offsets into JavaScript string indices.
 *
 * A code point may be one to four bytes; offsets always point at a character
 * boundary, so a single forward pass is enough and no allocation per token is
 * needed.
 */
export function byteOffsetsToIndices(statement: string, offsets: readonly number[]): number[] {
  if (offsets.length === 0) return [];
  const indices: number[] = [];
  let byteOffset = 0;
  let codeUnitIndex = 0;
  let target = 0;
  while (target < offsets.length && codeUnitIndex < statement.length) {
    const wanted = offsets[target]!;
    if (byteOffset === wanted) {
      indices.push(codeUnitIndex);
      target += 1;
      continue;
    }
    if (byteOffset > wanted) {
      // Not a character boundary; fail closed by pointing at the current index.
      indices.push(codeUnitIndex);
      target += 1;
      continue;
    }
    const codePoint = statement.codePointAt(codeUnitIndex)!;
    byteOffset += utf8Length(codePoint);
    codeUnitIndex += codePoint > 0xffff ? 2 : 1;
  }
  while (target < offsets.length) {
    indices.push(codeUnitIndex);
    target += 1;
  }
  return indices;
}

function utf8Length(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function isKeyword(token: Token | undefined, keyword: string): boolean {
  return token !== undefined && token.type === TOKEN_KEYWORD && token.text.toUpperCase() === keyword;
}

function isOperator(token: Token | undefined, operator: string): boolean {
  return token !== undefined && token.type === TOKEN_OPERATOR && token.text === operator;
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
 * Used only by the fallback path (no tokenizer). The scanner understands
 * single-quoted strings (with `''` escapes), double-quoted identifiers,
 * dollar-quoted strings, line comments and block comments, because all of them
 * may legally contain a semicolon.
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
