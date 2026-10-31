import assert from "node:assert/strict";
import test from "node:test";

import { normalizeRows, toWasmParameters } from "../dist/index.js";

test("passes through JSON-representable parameters", () => {
  assert.deepEqual(toWasmParameters(["text", 1.5, true, false, null]), ["text", 1.5, true, false, null]);
});

test("narrows safe bigints and rejects unsafe ones", () => {
  assert.deepEqual(toWasmParameters([1n, 9007199254740991n]), [1, 9007199254740991]);
  assert.throws(
    () => toWasmParameters([9007199254740993n]),
    (error) => error.code === "INVALID_ARGUMENT" && error.details?.parameter === 0,
  );
});

test("rejects values the JSON-based binding cannot represent", () => {
  for (const value of [new Date(0), new Uint8Array([1, 2]), { a: 1 }, Symbol("x"), () => 1]) {
    assert.throws(() => toWasmParameters([value]), (error) => error.code === "INVALID_ARGUMENT");
  }
});

test("normalises Arrow rows, copies bytes and keeps bigint", () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const rows = normalizeRows([
    { toJSON: () => ({ id: "a", n: 1n, blob: bytes, nested: { list: [bytes] }, at: new Date(0) }) },
  ]);
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.id, "a");
  assert.equal(row.n, 1n);
  assert.notEqual(row.blob, bytes);
  assert.deepEqual(row.blob, new Uint8Array([1, 2, 3]));
  assert.deepEqual(row.nested, { list: [new Uint8Array([1, 2, 3])] });
  assert.ok(row.at instanceof Date);
});
