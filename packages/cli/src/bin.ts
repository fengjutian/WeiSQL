#!/usr/bin/env node
import { stat } from "node:fs/promises";
import path from "node:path";

import { packPackage } from "./pack.js";
import { unpackContainer } from "./unpack.js";
import { validateContainer, validatePackage } from "./validate.js";
import type { ValidationResult } from "./validate.js";
import type { IntegrityMode } from "@weisql/sdk";

const USAGE = `Usage: weisql <command> [options]

Commands:
  validate <directory|file.wsql>   Validate a package or a packed container
  pack <directory>                 Pack a package into a single .wsql container
  unpack <file.wsql>               Extract a container after verifying its digests

Options:
  --mode <none|manifest|all>   Integrity mode for validate (default: all)
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
  json: boolean;
  help: boolean;
}

function parseArguments(argv: readonly string[]): ParsedArguments | string {
  const parsed: ParsedArguments = { command: undefined, target: undefined, mode: "all", output: undefined, json: false, help: false };
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
  if (parsed.command !== "validate" && parsed.command !== "pack" && parsed.command !== "unpack") {
    console.error(`error: unknown command '${parsed.command}'`);
    console.error(USAGE);
    return 2;
  }
  if (parsed.target === undefined) {
    console.error(`error: ${parsed.command} requires a path`);
    console.error(USAGE);
    return 2;
  }

  if (parsed.command === "unpack") {
    const target = parsed.output ?? path.basename(parsed.target, path.extname(parsed.target));
    try {
      const unpacked = await unpackContainer({ file: parsed.target, directory: path.resolve(target) });
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
      const packed = await packPackage({ directory: parsed.target, ...(parsed.output === undefined ? {} : { output: parsed.output }) });
      if (parsed.json) console.log(JSON.stringify(packed, null, 2));
      else {
        console.log(`package:   ${packed.directory}`);
        console.log(`container: ${packed.output} (${packed.containerBytes} bytes)`);
        console.log(`files:     ${packed.files.length}`);
        for (const file of packed.files) console.log(`  ${file.path}  ${file.bytes} B`);
        console.log("OK");
      }
      return 0;
    } catch (cause) {
      console.error(`error: ${cause instanceof Error ? cause.message : String(cause)}`);
      return 1;
    }
  }

  const info = await stat(parsed.target).catch(() => undefined);
  const isContainer = info?.isFile() === true;
  const result: ValidationResult & { container?: { files: number; mismatches: number } } = isContainer
    ? await validateContainer({ file: parsed.target, mode: parsed.mode })
    : await validatePackage({ directory: parsed.target, mode: parsed.mode });

  if (parsed.json) {
    console.log(JSON.stringify({
      ok: result.ok,
      target: result.directory,
      kind: isContainer ? "container" : "directory",
      mode: result.mode,
      datasetId: result.manifest?.datasetId ?? null,
      container: result.container ?? null,
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
