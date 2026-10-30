#!/usr/bin/env node
import { validatePackage } from "./validate.js";
import type { ValidationResult } from "./validate.js";
import type { IntegrityMode } from "@weisql/sdk";

const USAGE = `Usage: weisql <command> [options]

Commands:
  validate <directory>   Validate a data package (Manifest L1/L2 + resource L3)

Options:
  --mode <none|manifest|all>   Integrity mode for validate (default: all)
  --json                       Print machine-readable JSON
  --help, -h                   Show this help

Exit codes:
  0  package is valid
  1  package is invalid
  2  usage error
`;

interface ParsedArguments {
  command: string | undefined;
  target: string | undefined;
  mode: IntegrityMode;
  json: boolean;
  help: boolean;
}

function parseArguments(argv: readonly string[]): ParsedArguments | string {
  const parsed: ParsedArguments = { command: undefined, target: undefined, mode: "all", json: false, help: false };
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
  if (parsed.command !== "validate") {
    console.error(`error: unknown command '${parsed.command}'`);
    console.error(USAGE);
    return 2;
  }
  if (parsed.target === undefined) {
    console.error("error: validate requires a package directory");
    console.error(USAGE);
    return 2;
  }

  const result = await validatePackage({ directory: parsed.target, mode: parsed.mode });

  if (parsed.json) {
    console.log(JSON.stringify({
      ok: result.ok,
      directory: result.directory,
      mode: result.mode,
      datasetId: result.manifest?.datasetId ?? null,
      integrity: result.integrity ?? null,
      issues: result.issues,
    }, null, 2));
    return result.ok ? 0 : 1;
  }

  console.log(`package:   ${result.directory}`);
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
