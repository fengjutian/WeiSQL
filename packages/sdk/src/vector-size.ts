import { WeiSQLError } from "./errors.js";

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Calculate the byte length of uncompressed little-endian row-major Float32 vectors. */
export function expectedVectorBytes(count: number, dimension: number): number {
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(dimension) || count <= 0 || dimension <= 0) {
    invalid("Vector count and dimension must be positive safe integers", { count, dimension });
  }
  const bytes = BigInt(count) * BigInt(dimension) * 4n;
  if (bytes > MAX_SAFE) {
    invalid("Vector data exceeds JavaScript's safe integer range", { count, dimension });
  }
  return Number(bytes);
}

export function validateVectorBytes(input: Readonly<{ count: number; dimension: number; bytes: number }>): void {
  if (!Number.isSafeInteger(input.bytes) || input.bytes < 0) {
    invalid("Declared vector bytes must be a non-negative safe integer", input);
  }
  const expected = expectedVectorBytes(input.count, input.dimension);
  if (input.bytes !== expected) {
    invalid(`Expected ${expected} vector bytes, received ${input.bytes}`, { ...input, expected });
  }
}

function invalid(message: string, details: Readonly<Record<string, unknown>>): never {
  throw new WeiSQLError("MANIFEST_INVALID", message, { issueCode: "INVALID_VECTOR_SIZE", ...details });
}
