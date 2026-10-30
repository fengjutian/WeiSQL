import assert from "node:assert/strict";
import test from "node:test";
import { expectedVectorBytes, validateByteRange, validateResourcePath, validateVectorBytes, WeiSQLError } from "../dist/index.js";

test("WeiSQLError supports stable codes, details, causes, and the legacy constructor", () => {
  const cause = new TypeError("low-level failure");
  const error = new WeiSQLError({
    code: "RESOURCE_READ_FAILED",
    message: "Resource could not be read",
    details: { path: "data/documents.parquet" },
    cause,
  });
  assert.equal(error.name, "WeiSQLError");
  assert.equal(error.code, "RESOURCE_READ_FAILED");
  assert.deepEqual(error.details, { path: "data/documents.parquet" });
  assert.equal(error.cause, cause);
  assert.ok(error instanceof Error);
  assert.ok(error instanceof WeiSQLError);

  const legacy = new WeiSQLError("PATH_INVALID", "Unsafe path", { path: "../secret" });
  assert.equal(legacy.code, "PATH_INVALID");
  assert.deepEqual(legacy.details, { path: "../secret" });
});

test("calculates uncompressed Float32 vector bytes without numeric overflow", () => {
  assert.equal(expectedVectorBytes(100_000, 768), 307_200_000);
  assert.equal(expectedVectorBytes(0, 768), 0);
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
    "data/vector%20file", "data/file?download=1", "data/file#fragment", " data/file", "data/file ",
    "data/\0file", `data/${"a".repeat(1024)}`
  ];
  for (const path of invalid) assert.throws(() => validateResourcePath(path), { code: "PATH_INVALID" }, path);
});

test("validates half-open byte ranges", () => {
  assert.doesNotThrow(() => validateByteRange({ start: 0, end: 4096 }));
  assert.doesNotThrow(() => validateByteRange({ start: 8, end: 8 }));
  assert.throws(() => validateByteRange({ start: -1, end: 1 }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => validateByteRange({ start: 2, end: 1 }), { code: "INVALID_ARGUMENT" });
  assert.throws(() => validateByteRange({ start: 0.5, end: 1 }), { code: "INVALID_ARGUMENT" });
});
