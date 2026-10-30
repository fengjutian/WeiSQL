import { WeiSQLError } from "./errors.js";

/**
 * Validate a canonical package-relative resource path.
 *
 * This function is runtime-neutral and intentionally does not use Node.js path
 * APIs, so browser and Node.js runtimes enforce identical rules.
 */
export function validateResourcePath(path: string): void {
  if (path.length === 0 || path.trim() !== path) {
    invalid(path, "Resource path must be non-empty and have no surrounding whitespace");
  }
  if (
    path.startsWith("/") || path.startsWith("\\") ||
    /^[A-Za-z]:/.test(path) || path.includes("\\") || path.includes("\0") ||
    path.includes(":")
  ) {
    invalid(path, "Resource path must be relative and use forward slashes");
  }
  if (/%2e|%2f|%5c/i.test(path)) {
    invalid(path, "Encoded separators and dot segments are not allowed");
  }
  const segments = path.split("/");
  if (segments.some(segment => segment === "" || segment === "." || segment === "..")) {
    invalid(path, "Resource path contains an invalid segment");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(path)) {
    invalid(path, "Resource path contains unsupported characters");
  }
}

/** A validated path is already canonical under the strict V1 path grammar. */
export function canonicalResourcePath(path: string): string {
  validateResourcePath(path);
  return path;
}

function invalid(path: string, message: string): never {
  throw new WeiSQLError("PATH_INVALID", message, { path });
}
