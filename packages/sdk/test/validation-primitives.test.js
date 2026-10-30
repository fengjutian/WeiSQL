import assert from "node:assert/strict";
import test from "node:test";
import { expectedVectorBytes, validateByteRange, validateResourcePath, validateVectorBytes } from "../dist/index.js";

test("calculates uncompressed Float32 vector bytes without numeric overflow", () => {
  assert.equal(expectedVectorBytes(100_000, 768), 307_200_000);
  assert.throws(() => expectedVectorBytes(100, 0), { code: "MANIFEST_INVALID" });
  assert.throws(() => expectedVectorBytes(Number.MAX_SAFE_INTEGER, 768), { code: "MANIFEST_INVALID" });
  assert.throws(() => validateVectorBytes({ count: 100, dimension: 768, bytes: 100 }), error => {
    assert.equal(error.code, "MANIFEST_INVALID");
    assert.equal(error.details.issueCode, "INVALID_VECTOR_SIZE");
    return true;
  });
});

test("accepts canonical package-relative resource paths", () => {
  assert.doesNotThrow(() => validateResourcePath("data/documents.parquet"));
  assert.doesNotThrow(() => validateResourcePath("indexes/vector.index"));
});

test("rejects unsafe and ambiguous resource paths", () => {
  const invalid = [
    "../secret.txt", "/etc/passwd", "C:/secret.txt", "data\\secret.txt",
    "data//file", "./data/file", "data/%2e%2e/secret", "https://example.test/file",
    " data/file", "data/file ", "data/\0file"
  ];
  for (const path of invalid) assert.throws(() => validateResourcePath(path), { code: "PATH_INVALID" }, path);
});

test("validates half-open byte ranges", () => {
  assert.doesNotThrow(() => validateByteRange({ start: 0, end: 4096 }));
  assert.doesNotThrow(() => validateByteRange({ start: 8, end: 8 }));
  assert.throws(() => validateByteRange({ start: -1, end: 1 }), RangeError);
  assert.throws(() => validateByteRange({ start: 2, end: 1 }), RangeError);
  assert.throws(() => validateByteRange({ start: 0.5, end: 1 }), RangeError);
});
