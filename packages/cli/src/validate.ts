import { readFile } from "node:fs/promises";
import path from "node:path";

import { ContainerReader, NodeFileResourceReader, open, validateManifest, verifyManifestResources, verifyManifestSignature } from "@weisql/sdk";
import type { IntegrityMode, IntegrityReport, ResourceReader, WeiSQLError, WeiSQLManifest, VerifyManifestSignatureResult } from "@weisql/sdk";

export type ValidationStage = "manifest" | "resources" | "l4" | "signature";

export interface ValidationIssue {
  stage: ValidationStage;
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}

export interface L4Report {
  ok: boolean;
  tables: number;
}

export interface ValidatePackageOptions {
  directory: string;
  /** `all` verifies sizes and SHA-256; `manifest` verifies sizes only. */
  mode?: IntegrityMode;
  /** Also verify Parquet content against the Manifest (requires `@weisql/duckdb-adapter`). */
  l4?: boolean;
  /** Require a valid Ed25519 Manifest signature. */
  signature?: boolean;
  /** Pin expected publisher fingerprints; only meaningful with `signature`. */
  trustedKeyIds?: readonly string[];
  signal?: AbortSignal;
}

export interface ValidationResult {
  ok: boolean;
  directory: string;
  mode: IntegrityMode;
  manifest?: WeiSQLManifest;
  integrity?: IntegrityReport;
  l4?: L4Report;
  signature?: VerifyManifestSignatureResult;
  issues: ValidationIssue[];
}

/**
 * Validates a package directory without opening a runtime.
 *
 * This is the publish-time gate: L1/L2 structure, then L3 resource integrity.
 * It returns issues instead of throwing so the CLI can translate them into exit
 * codes and machine-readable output.
 */
export async function validatePackage(options: ValidatePackageOptions): Promise<ValidationResult> {
  const directory = path.resolve(options.directory);
  const mode: IntegrityMode = options.mode ?? "all";
  const issues: ValidationIssue[] = [];

  const result: ValidationResult = { ok: false, directory, mode, issues };

  let text: string;
  try {
    text = await readFile(path.join(directory, "manifest.json"), "utf8");
  } catch (cause) {
    issues.push({ stage: "manifest", code: "RESOURCE_NOT_FOUND", message: "manifest.json is missing or unreadable", details: { cause: String(cause) } });
    return result;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    issues.push({ stage: "manifest", code: "MANIFEST_INVALID", message: "manifest.json is not valid JSON", details: { cause: String(cause) } });
    return result;
  }

  let manifest: WeiSQLManifest;
  try {
    manifest = validateManifest(parsed);
  } catch (cause) {
    issues.push(toIssue("manifest", cause));
    return result;
  }
  result.manifest = manifest;

  const reader = new NodeFileResourceReader({ rootDirectory: directory });
  try {
    result.integrity = await verifyManifestResources({
      manifest,
      reader,
      options: { mode, ...(options.signal === undefined ? {} : { signal: options.signal }) },
    });
  } catch (cause) {
    issues.push(toIssue("resources", cause));
  } finally {
    await reader.close().catch(() => undefined);
  }

  if (options.l4 && manifest.tables.length > 0) {
    try {
      result.l4 = await runL4(manifest, new NodeFileResourceReader({ rootDirectory: directory }), options.signal);
    } catch (cause) {
      result.l4 = { ok: false, tables: 0 };
      issues.push(toIssue("l4", cause));
    }
  }

  if (options.signature) {
    await checkSignature(manifest, options, result, issues);
  }

  result.ok = issues.length === 0;
  return result;
}

/**
 * L4: open the package through the DuckDB adapter so the Parquet content is
 * compared with the Manifest (columns, types, row count).
 *
 * The adapter is an optional peer: the CLI must stay usable without a native
 * binding, so a missing module becomes an L4 issue instead of a crash.
 */
async function runL4(manifest: WeiSQLManifest, reader: ResourceReader, signal: AbortSignal | undefined): Promise<L4Report> {
  let module: typeof import("@weisql/duckdb-adapter");
  try {
    module = await import("@weisql/duckdb-adapter");
  } catch (cause) {
    throw Object.assign(new Error("L4 validation requires @weisql/duckdb-adapter to be installed"), {
      code: "SQL_UNSUPPORTED",
      details: { cause: String(cause) },
    });
  }
  const db = await open({
    manifest,
    resourceReader: reader,
    sqlAdapter: module.createDuckDbAdapter({ tableLoading: "lazy" }),
    ...(signal === undefined ? {} : { signal }),
  });
  await db.close();
  return { ok: true, tables: manifest.tables.length };
}

async function checkSignature(
  manifest: WeiSQLManifest,
  options: { trustedKeyIds?: readonly string[] },
  result: ValidationResult,
  issues: ValidationIssue[],
): Promise<void> {
  try {
    result.signature = await verifyManifestSignature(manifest, {
      ...(options.trustedKeyIds === undefined ? {} : { trustedKeyIds: options.trustedKeyIds }),
    });
    if (!result.signature.valid) {
      issues.push({
        stage: "signature",
        code: "SIGNATURE_INVALID",
        message: `Manifest signature is not valid (${result.signature.reason ?? "unknown"})`,
        ...(result.signature.keyId === undefined ? {} : { details: { keyId: result.signature.keyId } }),
      });
    }
  } catch (cause) {
    issues.push(toIssue("signature", cause));
  }
}

function toIssue(stage: ValidationStage, cause: unknown): ValidationIssue {
  const error = cause as Partial<WeiSQLError> & { message?: string };
  const code = typeof error.code === "string" ? error.code : "INTERNAL_ERROR";
  const details = error.details as Readonly<Record<string, unknown>> | undefined;
  return {
    stage,
    code,
    message: typeof error.message === "string" ? error.message : String(cause),
    ...(details === undefined ? {} : { details }),
  };
}

export interface ContainerValidationResult extends ValidationResult {
  file: string;
  container?: { files: number; mismatches: number };
}

export interface ValidateContainerOptions {
  file: string;
  /** `all` verifies container entry digests and Manifest resource digests. */
  mode?: IntegrityMode;
  /** Also verify Parquet content against the Manifest (requires `@weisql/duckdb-adapter`). */
  l4?: boolean;
  /** Require a valid Ed25519 Manifest signature. */
  signature?: boolean;
  /** Pin expected publisher fingerprints; only meaningful with `signature`. */
  trustedKeyIds?: readonly string[];
  signal?: AbortSignal;
}

/**
 * Validates a `.wsql` container without extracting it.
 *
 * Runs the same L1/L2/L3 gates as a directory, plus the container's own
 * per-entry digests, so a truncated or tampered container fails before any query.
 */
export async function validateContainer(options: ValidateContainerOptions): Promise<ContainerValidationResult> {
  const file = path.resolve(options.file);
  const mode: IntegrityMode = options.mode ?? "all";
  const issues: ValidationIssue[] = [];
  const result: ContainerValidationResult = { ok: false, directory: file, file, mode, issues };

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(file));
  } catch (cause) {
    issues.push({ stage: "manifest", code: "RESOURCE_NOT_FOUND", message: "container file is missing or unreadable", details: { cause: String(cause) } });
    return result;
  }

  let reader: ContainerReader;
  try {
    reader = new ContainerReader(bytes);
  } catch (cause) {
    issues.push(toIssue("manifest", cause));
    return result;
  }

  try {
    result.container = { files: reader.header.files.length, mismatches: 0 };
    if (mode !== "none") {
      const mismatches = await reader.verify();
      result.container.mismatches = mismatches.length;
      for (const mismatch of mismatches) {
        issues.push({
          stage: "resources",
          code: "RESOURCE_INTEGRITY_FAILED",
          message: `container digest mismatch for ${mismatch.path}`,
          details: { path: mismatch.path, expected: mismatch.expected, actual: mismatch.actual },
        });
      }
    }

    let manifest: WeiSQLManifest;
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await reader.read("manifest.json"));
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        issues.push({ stage: "manifest", code: "MANIFEST_INVALID", message: "manifest.json is not valid JSON", details: { cause: String(cause) } });
        return result;
      }
      manifest = validateManifest(parsed);
    } catch (cause) {
      issues.push(toIssue("manifest", cause));
      return result;
    }
    result.manifest = manifest;

    try {
      result.integrity = await verifyManifestResources({
        manifest,
        reader,
        options: { mode, ...(options.signal === undefined ? {} : { signal: options.signal }) },
      });
    } catch (cause) {
      issues.push(toIssue("resources", cause));
    }

    if (options.l4 && manifest.tables.length > 0) {
      try {
        result.l4 = await runL4(manifest, reader, options.signal);
      } catch (cause) {
        result.l4 = { ok: false, tables: 0 };
        issues.push(toIssue("l4", cause));
      }
    }

    if (options.signature) {
      await checkSignature(manifest, options, result, issues);
    }
  } finally {
    await reader.close().catch(() => undefined);
  }

  result.ok = issues.length === 0;
  return result;
}
