/**
 * One list of SQL behavior every adapter must satisfy, shared by the contract
 * runner. Cases run against both the Node and the DuckDB-Wasm adapter, so a
 * difference has to be *declared* here instead of hiding in one package's test
 * file.
 *
 * `expect`:
 * - omitted: both adapters must succeed and return the same rows;
 * - `{ error }`: both adapters must reject with that code;
 * - `wasmError` / `nodeError`: a declared difference — one side succeeds and
 *   the other returns the listed code, with the reason in `note`.
 */
export const CONTRACT_CASES = [
  {
    name: "select rows",
    sql: "select id, title from documents order by id",
  },
  {
    name: "parameter binding",
    sql: "select id from documents where id = ?",
    params: ["doc-002"],
  },
  {
    name: "parameter is not SQL syntax",
    sql: "select id from documents where id = ?",
    params: ["' OR 1=1 --"],
  },
  {
    name: "null parameter",
    sql: "select ? is null as is_null",
    params: [null],
  },
  {
    name: "read-only CTE",
    sql: "with g as (select id from documents where category = ?) select id from g order by id",
    params: ["genetics"],
  },
  {
    name: "aggregate returns bigint",
    sql: "select count(*) as n from documents",
  },
  {
    name: "decimal maps to number",
    sql: "select 1.5 as f",
  },
  {
    name: "write is rejected",
    sql: "delete from documents",
    expect: { error: "SQL_UNSUPPORTED" },
  },
  {
    name: "multiple statements are rejected",
    sql: "select 1; select 2",
    expect: { error: "SQL_UNSUPPORTED" },
  },
  {
    name: "unknown column is rejected",
    sql: "select missing from documents",
    expect: { error: "INVALID_ARGUMENT" },
  },
  {
    name: "write CTE is rejected",
    sql: "with x as (select 1) delete from documents",
    expect: { error: "SQL_UNSUPPORTED" },
  },
  {
    name: "external file access is blocked",
    sql: "select * from read_parquet('examples/fixture/data/documents.parquet')",
    expect: { error: "SQL_UNSUPPORTED" },
  },
  {
    name: "maxRows within budget",
    sql: "select id from documents order by id",
    options: { maxRows: 5 },
  },
  {
    name: "maxRows exceeded is rejected",
    sql: "select id from documents order by id",
    options: { maxRows: 2 },
    expect: { error: "INVALID_ARGUMENT" },
  },
  {
    name: "stream rows",
    sql: "select id from documents order by id",
    stream: true,
  },
  {
    name: "stream maxRows exceeded",
    sql: "select id from documents order by id",
    stream: true,
    options: { maxRows: 2 },
    expect: { error: "INVALID_ARGUMENT" },
  },
  {
    name: "stream write is rejected",
    sql: "delete from documents",
    stream: true,
    expect: { error: "SQL_UNSUPPORTED" },
  },
  {
    name: "stream unknown column is rejected",
    sql: "select missing from documents",
    stream: true,
    expect: { error: "INVALID_ARGUMENT" },
  },
  {
    name: "stream pre-aborted",
    sql: "select id from documents order by id",
    stream: true,
    abort: true,
    expect: { error: "QUERY_CANCELLED" },
  },
  {
    name: "stream break leaves the adapter usable",
    sql: "select id from documents order by id",
    stream: true,
    breakAfter: 1,
    thenSql: "select 1 as ok",
  },
  {
    name: "Date parameter",
    sql: "select ? is not null as ok",
    params: [new Date(0)],
    wasmError: "INVALID_ARGUMENT",
    note: "DuckDB-Wasm binds parameters through JSON; Date has no faithful representation",
  },
  {
    name: "binary parameter",
    sql: "select octet_length(?) as n",
    params: [new Uint8Array([1, 2, 3])],
    wasmError: "INVALID_ARGUMENT",
    note: "DuckDB-Wasm binds parameters through JSON; binary has no faithful representation",
  },
];
