#!/usr/bin/env node
import { stat } from "node:fs/promises";
import path from "node:path";

import { packPackage } from "./pack.js";
import { inspectPackage } from "./inspect.js";
import { generateKeyFiles, signPackage, verifyPackageSignature } from "./signing.js";
import { unpackContainer } from "./unpack.js";
import { validateContainer, validatePackage } from "./validate.js";
import type { ValidationResult } from "./validate.js";
import type { IntegrityMode } from "@weisql/sdk";

const USAGE = `Usage: weisql <command> [options]

Commands:
  validate <directory|file.wsql>   Validate a package or a packed container
  pack <directory>                 Pack a package into a single .wsql container
  unpack <file.wsql>               Extract a container after verifying its digests
  keygen [--output <prefix>]       Create an Ed25519 signing key pair
  sign <dir|file.wsql> --key <pem> Sign the Manifest
  verify-signature <dir|file.wsql> Verify the Manifest signature
  inspect <dir|file.wsql>           Summarize a package without opening it

Options:
  --mode <none|manifest|all>   Integrity mode for validate (default: all)
  --l4                         Also verify Parquet content (needs @weisql/duckdb-adapter)
  --signature                  Require a valid Manifest signature
  --trusted <keyId>            Pin a publisher fingerprint (repeatable)
  --require <n>                Require n pinned keys to have signed (endorsement policy)
  --key <pem>                  Private key for sign
  --public <pem>               Public key for sign (derived when omitted)
  --add                        Add a co-signature instead of replacing (key rotation)
  --compress                   Gzip entries when packing (container format 1.1.0)
  --only-declared              Pack only the Manifest and declared resources
  --output <file|directory>    Output path for pack / unpack
  --json                       Print machine-readable JSON
  --help, -h                   Show this help

Exit codes:
  0  package is valid / pack succeeded
  1  package is invalid
  2  usage error
`;

interface ParsedArguments {
  command: string | undefined;
  target: string | undefined;
  mode: IntegrityMode;
  output: string | undefined;
  l4: boolean;
  signature: boolean;
  compress: boolean;
  onlyDeclared: boolean;
  addSignature: boolean;
  keyPath: string | undefined;
  publicKeyPath: string | undefined;
  trustedKeyIds: string[];
  minimumTrustedSignatures: number | undefined;
  json: boolean;
  help: boolean;
}

function parseArguments(argv: readonly string[]): ParsedArguments | string {
  const parsed: ParsedArguments = { command: undefined, target: undefined, mode: "all", output: undefined, l4: false, signature: false, compress: false, onlyDeclared: false, addSignature: false, keyPath: undefined, publicKeyPath: undefined, trustedKeyIds: [], minimumTrustedSignatures: undefined, json: false, help: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") {
      parsed.help = true;
      continue;
    }
    if (argument === "--json") {
      parsed.json = true;
      continue;
    }
    if (argument === "--l4") {
      parsed.l4 = true;
      continue;
    }
    if (argument === "--compress") {
      parsed.compress = true;
      continue;
    }
    if (argument === "--signature") {
      parsed.signature = true;
      continue;
    }
    if (argument === "--only-declared") {
      parsed.onlyDeclared = true;
      continue;
    }
    if (argument === "--add") {
      parsed.addSignature = true;
      continue;
    }
    if (argument === "--trusted" || argument.startsWith("--trusted=")) {
      const value = argument === "--trusted" ? argv[index + 1] : argument.slice("--trusted=".length);
      if (value === undefined || value === "") return "--trusted requires a key id";
      if (argument === "--trusted") index++;
      parsed.trustedKeyIds.push(value);
      continue;
    }
    if (argument === "--require" || argument.startsWith("--require=")) {
      const value = argument === "--require" ? argv[index + 1] : argument.slice("--require=".length);
      if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) return "--require needs a positive integer";
      if (argument === "--require") index++;
      parsed.minimumTrustedSignatures = Number(value);
      continue;
    }
    if (argument === "--key" || argument.startsWith("--key=")) {
      const value = argument === "--key" ? argv[index + 1] : argument.slice("--key=".length);
      if (value === undefined || value === "") return "--key requires a path";
      if (argument === "--key") index++;
      parsed.keyPath = value;
      continue;
    }
    if (argument === "--public" || argument.startsWith("--public=")) {
      const value = argument === "--public" ? argv[index + 1] : argument.slice("--public=".length);
      if (value === undefined || value === "") return "--public requires a path";
      if (argument === "--public") index++;
      parsed.publicKeyPath = value;
      continue;
    }
    if (argument === "--mode") {
      const value = argv[index + 1];
      if (value === undefined) return "--mode requires a value";
      index++;
      if (value !== "none" && value !== "manifest" && value !== "all") return `unknown mode '${value}'`;
      parsed.mode = value;
      continue;
    }
    if (argument.startsWith("--mode=")) {
      const value = argument.slice("--mode=".length);
      if (value !== "none" && value !== "manifest" && value !== "all") return `unknown mode '${value}'`;
      parsed.mode = value;
      continue;
    }
    if (argument === "--output" || argument.startsWith("--output=")) {
      const value = argument === "--output" ? argv[index + 1] : argument.slice("--output=".length);
      if (value === undefined || value === "") return "--output requires a value";
      if (argument === "--output") index++;
      parsed.output = value;
      continue;
    }
    if (argument.startsWith("-")) return `unknown option '${argument}'`;
    if (parsed.command === undefined) parsed.command = argument;
    else if (parsed.target === undefined) parsed.target = argument;
    else return `unexpected argument '${argument}'`;
  }
  return parsed;
}

function summarize(result: ValidationResult): string[] {
  const lines: string[] = [];
  if (result.manifest !== undefined) {
    lines.push(`dataset:   ${result.manifest.datasetId}`);
    lines.push(`tables:    ${result.manifest.tables.length} (${result.manifest.tables.map(table => table.name).join(", ") || "none"})`);
    lines.push(`vectors:   ${result.manifest.vectorCollections.length} (${result.manifest.vectorCollections.map(collection => `${collection.name}: ${collection.count} rows, dimension ${collection.dimension}, ${collection.metric}`).join("; ") || "none"})`);
    if ((result.manifest.textIndexes?.length ?? 0) > 0) {
      lines.push(`text:      ${result.manifest.textIndexes!.length} (${result.manifest.textIndexes!.map(index => `${index.name}: ${index.termCount} terms`).join("; ")})`);
    }
  }
  lines.push(`mode:      ${result.mode}`);
  if (result.integrity !== undefined) {
    lines.push(`resources: ${result.integrity.checkedResources} checked, ${result.integrity.sizeVerified} sizes verified, ${result.integrity.hashesVerified} hashes verified, ${result.integrity.totalDeclaredBytes} declared bytes`);
  }
  if (result.l4 !== undefined) {
    lines.push(`l4:        ${result.l4.ok ? `${result.l4.tables} table(s) matched the Manifest` : "failed"}`);
  }
  if (result.signature !== undefined) {
    lines.push(`signature: ${result.signature.valid ? `valid (${result.signature.keyIds.join(", ")})` : `invalid (${result.signature.reason ?? "unknown"})`}`);
  }
  return lines;
}

function formatIssue(issue: ValidationResult["issues"][number]): string {
  const location = issue.details?.path;
  return `[${issue.stage}] ${issue.code}: ${issue.message}${typeof location === "string" ? ` (${location})` : ""}`;
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parseArguments(argv);
  if (typeof parsed === "string") {
    console.error(`error: ${parsed}`);
    console.error(USAGE);
    return 2;
  }
  if (parsed.help || parsed.command === undefined) {
    console.log(USAGE);
    return parsed.help ? 0 : 2;
  }
  if (!["validate", "pack", "unpack", "keygen", "sign", "verify-signature", "inspect"].includes(parsed.command)) {
    console.error(`error: unknown command '${parsed.command}'`);
    console.error(USAGE);
    return 2;
  }
  if (parsed.command === "keygen") {
    try {
      const generated = await generateKeyFiles(parsed.output ?? "weisql-signing-key");
      if (parsed.json) console.log(JSON.stringify(generated, null, 2));
      else {
        console.log(`key id:    ${generated.keyId}`);
        console.log(`private:   ${generated.privateKeyPath} (mode 0600)`);
        console.log(`public:    ${generated.publicKeyPath}`);
        console.log("OK");
      }
      return 0;
    } catch (cause) {
      console.error(`error: ${cause instanceof Error ? cause.message : String(cause)}`);
      return 1;
    }
  }

  if (parsed.target === undefined) {
    console.error(`error: ${parsed.command} requires a path`);
    console.error(USAGE);
    return 2;
  }
  const target = parsed.target;

  if (parsed.command === "inspect") {
    try {
      const summary = await inspectPackage(target);
      if (parsed.json) console.log(JSON.stringify(summary, null, 2));
      else {
        console.log(`${summary.kind}:  ${summary.target}`);
        console.log(`dataset:   ${summary.datasetId} (format ${summary.formatVersion})`);
        console.log(`tables:    ${summary.tables.map(table => `${table.name} (${table.columns} columns, ${table.bytes} B)`).join("; ") || "none"}`);
        console.log(`vectors:   ${summary.vectors.map(vector => `${vector.name}: ${vector.count} × ${vector.dimension} ${vector.metric}${vector.persistedIndex ? ", index" : ""}`).join("; ") || "none"}`);
        if (summary.textIndexes.length > 0) {
          console.log(`text:      ${summary.textIndexes.map(index => `${index.name}: ${index.documents} docs, ${index.terms} terms${index.hasDocuments ? ", documents" : ""}`).join("; ")}`);
        }
        if (summary.container !== undefined) {
          console.log(`container: ${summary.container.files} files${summary.container.compression === undefined ? "" : `, ${summary.container.compression}`}`);
        }
        console.log(`signature: ${summary.signature.present ? (summary.signature.valid ? `valid (${summary.signature.keyId})` : `invalid (${summary.signature.reason})`) : "absent"}`);
        console.log(`resources: ${summary.resources.declaredFiles} declared, ${summary.resources.files} files, ${summary.resources.declaredBytes} declared bytes`);
        if (summary.resources.undeclared.length > 0) {
          console.log(`undeclared: ${summary.resources.undeclared.join(", ")}`);
        }
        console.log("OK");
      }
      return 0;
    } catch (cause) {
      console.error(`error: ${cause instanceof Error ? cause.message : String(cause)}`);
      return 1;
    }
  }

  if (parsed.command === "verify-signature") {
    try {
      const verified = await verifyPackageSignature({
        target,
        ...(parsed.trustedKeyIds.length === 0 ? {} : { trustedKeyIds: parsed.trustedKeyIds }),
        ...(parsed.minimumTrustedSignatures === undefined ? {} : { minimumTrustedSignatures: parsed.minimumTrustedSignatures }),
      });
      if (parsed.json) console.log(JSON.stringify(verified, null, 2));
      else {
        console.log(`target:    ${verified.target} (${verified.kind})`);
        console.log(`dataset:   ${verified.datasetId}`);
        console.log(`key ids:   ${verified.keyIds.join(", ")}`);
        console.log(verified.valid ? "OK" : `FAILED (${verified.reason})`);
      }
      return verified.valid ? 0 : 1;
    } catch (cause) {
      console.error(`error: ${cause instanceof Error ? cause.message : String(cause)}`);
      return 1;
    }
  }

  if (parsed.command === "sign") {
    if (parsed.keyPath === undefined) {
      console.error("error: sign requires --key <private.pem>");
      return 2;
    }
    try {
      const signed = await signPackage({
        target,
        privateKeyPath: parsed.keyPath,
        ...(parsed.publicKeyPath === undefined ? {} : { publicKeyPath: parsed.publicKeyPath }),
        add: parsed.addSignature,
      });
      if (parsed.json) console.log(JSON.stringify(signed, null, 2));
      else {
        console.log(`target:    ${signed.target} (${signed.kind})`);
        console.log(`dataset:   ${signed.datasetId}`);
        console.log(`key ids:   ${signed.keyIds.join(", ")}`);
        console.log("OK");
      }
      return 0;
    } catch (cause) {
      console.error(`error: ${cause instanceof Error ? cause.message : String(cause)}`);
      return 1;
    }
  }

  if (parsed.command === "unpack") {
    const outputDirectory = parsed.output ?? path.basename(target, path.extname(target));
    try {
      const unpacked = await unpackContainer({ file: target, directory: path.resolve(outputDirectory) });
      if (parsed.json) console.log(JSON.stringify(unpacked, null, 2));
      else {
        console.log(`container: ${unpacked.file}`);
        console.log(`directory: ${unpacked.directory} (${unpacked.digestsVerified} digests verified)`);
        console.log(`files:     ${unpacked.files.length} (${unpacked.bytes} bytes)`);
        for (const file of unpacked.files) console.log(`  ${file}`);
        console.log("OK");
      }
      return 0;
    } catch (cause) {
      console.error(`error: ${cause instanceof Error ? cause.message : String(cause)}`);
      return 1;
    }
  }

  if (parsed.command === "pack") {
    if (parsed.mode !== "all") {
      console.error("error: --mode only applies to validate");
      return 2;
    }
    try {
      const packed = await packPackage({
        directory: target,
        compress: parsed.compress,
        onlyDeclared: parsed.onlyDeclared,
        ...(parsed.output === undefined ? {} : { output: parsed.output }),
      });
      if (parsed.json) console.log(JSON.stringify(packed, null, 2));
      else {
        console.log(`package:   ${packed.directory}`);
        console.log(`container: ${packed.output} (${packed.containerBytes} bytes${packed.compressed ? ", gzip" : ""})`);
        console.log(`files:     ${packed.files.length}`);
        for (const file of packed.files) console.log(`  ${file.path}  ${file.bytes} B`);
        if (packed.skipped.length > 0) console.log(`skipped:   ${packed.skipped.join(", ")}`);
        console.log("OK");
      }
      return 0;
    } catch (cause) {
      console.error(`error: ${cause instanceof Error ? cause.message : String(cause)}`);
      return 1;
    }
  }

  const info = await stat(target).catch(() => undefined);
  const isContainer = info?.isFile() === true;
  const result: ValidationResult & { container?: { files: number; mismatches: number } } = isContainer
    ? await validateContainer({ file: target, mode: parsed.mode, l4: parsed.l4, signature: parsed.signature, ...(parsed.trustedKeyIds.length === 0 ? {} : { trustedKeyIds: parsed.trustedKeyIds }), ...(parsed.minimumTrustedSignatures === undefined ? {} : { minimumTrustedSignatures: parsed.minimumTrustedSignatures }) })
    : await validatePackage({ directory: target, mode: parsed.mode, l4: parsed.l4, signature: parsed.signature, ...(parsed.trustedKeyIds.length === 0 ? {} : { trustedKeyIds: parsed.trustedKeyIds }), ...(parsed.minimumTrustedSignatures === undefined ? {} : { minimumTrustedSignatures: parsed.minimumTrustedSignatures }) });

  if (parsed.json) {
    console.log(JSON.stringify({
      ok: result.ok,
      target: result.directory,
      kind: isContainer ? "container" : "directory",
      mode: result.mode,
      datasetId: result.manifest?.datasetId ?? null,
      container: result.container ?? null,
      l4: result.l4 ?? null,
      signature: result.signature ?? null,
      integrity: result.integrity ?? null,
      issues: result.issues,
    }, null, 2));
    return result.ok ? 0 : 1;
  }

  console.log(`${isContainer ? "container" : "package"}:   ${result.directory}`);
  if (result.container !== undefined) {
    console.log(`container: ${result.container.files} files, ${result.container.mismatches} digest mismatch(es)`);
  }
  for (const line of summarize(result)) console.log(line);
  if (result.ok) {
    console.log("OK");
    return 0;
  }
  console.error(`FAILED (${result.issues.length} issue${result.issues.length === 1 ? "" : "s"})`);
  for (const issue of result.issues) console.error(`  ${formatIssue(issue)}`);
  return 1;
}

// `process.exitCode` keeps piped stdout flushed; calling process.exit() can truncate it.
process.exitCode = await main(process.argv.slice(2));
