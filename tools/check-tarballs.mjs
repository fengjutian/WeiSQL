#!/usr/bin/env node
/**
 * Verifies what `npm pack` would actually publish, without publishing.
 *
 * `release-check.mjs` inspects metadata and the dist directory; this script
 * inspects the packed file list, which is what a consumer actually installs.
 * It fails on source/test files leaking into the tarball, a missing LICENSE or
 * README, or an `exports` target that does not exist on disk.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const ROOT = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));

const ALLOWED_EXACT = new Set(["package.json", "README.md", "LICENSE"]);
const ALLOWED_PREFIXES = ["dist/", "wasm/"];
const FORBIDDEN = [/^src\//, /^test\//, /\/node_modules\//, /\.test\.[cm]?[jt]s$/, /\.ts$/];
const FORBIDDEN_EXCEPTIONS = [/\.d\.ts$/];

async function packageDirectories() {
  const root = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const patterns = root.workspaces ?? [];
  const directories = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("/*")) {
      const parent = path.join(ROOT, pattern.slice(0, -2));
      for (const entry of await readdir(parent, { withFileTypes: true })) {
        if (entry.isDirectory() && existsSync(path.join(parent, entry.name, "package.json"))) {
          directories.push(path.join(parent, entry.name));
        }
      }
    } else if (existsSync(path.join(ROOT, pattern, "package.json"))) {
      directories.push(path.join(ROOT, pattern));
    }
  }
  return directories.sort();
}

// Prefer the npm CLI script next to the running Node binary: spawning it with
// that interpreter avoids `shell: true` (and its argument-escaping warning).
const NPM_CLI = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const USE_NPM_CLI = existsSync(NPM_CLI);

async function pack(directory) {
  const command = USE_NPM_CLI ? process.execPath : "npm";
  const args = USE_NPM_CLI
    ? [NPM_CLI, "pack", "--dry-run", "--json", "--ignore-scripts"]
    : ["pack", "--dry-run", "--json", "--ignore-scripts"];
  const { stdout } = await run(command, args, {
    cwd: directory,
    shell: !USE_NPM_CLI,
    maxBuffer: 16 * 1024 * 1024,
  });
  const reports = JSON.parse(stdout);
  if (!Array.isArray(reports) || reports.length !== 1) throw new Error(`unexpected npm pack output in ${directory}`);
  return reports[0];
}

function checkFileList(files) {
  const problems = [];
  const paths = files.map(file => file.path);
  const present = new Set(paths);
  for (const required of ["package.json", "README.md", "LICENSE", "dist/index.js"]) {
    if (!present.has(required)) problems.push(`missing ${required} in tarball`);
  }
  for (const file of paths) {
    if (ALLOWED_EXACT.has(file)) continue;
    if (ALLOWED_PREFIXES.some(prefix => file.startsWith(prefix))) continue;
    problems.push(`unexpected file in tarball: ${file}`);
    continue;
  }
  for (const file of paths) {
    const forbidden = FORBIDDEN.some(pattern => pattern.test(file)) && !FORBIDDEN_EXCEPTIONS.some(pattern => pattern.test(file));
    if (forbidden) problems.push(`source or test file leaked into tarball: ${file}`);
  }
  return problems;
}

function checkExports(manifest, directory) {
  const problems = [];
  const walk = (value, keyPath) => {
    if (typeof value === "string") {
      if (!value.startsWith("./")) {
        problems.push(`exports${keyPath} must start with './' (got ${value})`);
      } else if (value.includes("*")) {
        // Wildcard exports (e.g. "./wasm/*") name a directory, not one file.
        // Require that directory to exist; individual files are checked by the
        // package's own tests and release:check.
        const prefix = value.slice(0, value.indexOf("*"));
        const directoryPath = path.join(directory, prefix.endsWith("/") ? prefix : path.dirname(prefix));
        if (!existsSync(directoryPath)) problems.push(`exports${keyPath} points to a missing directory: ${value}`);
      } else if (!existsSync(path.join(directory, value))) {
        problems.push(`exports${keyPath} points to a missing file: ${value}`);
      }
      return;
    }
    if (value === null) {
      problems.push(`exports${keyPath} is null, which removes the entry point`);
      return;
    }
    if (typeof value === "object") {
      for (const [key, child] of Object.entries(value)) walk(child, `${keyPath}.${key}`);
    }
  };
  walk(manifest.exports, "");
  return problems;
}

if (process.argv.includes("--self-test")) {
  const good = ["package.json", "README.md", "LICENSE", "dist/index.js", "dist/index.d.ts"].map(file => ({ path: file }));
  const cases = [
    { label: "clean tarball", files: good, expected: 0 },
    { label: "source leak", files: [...good, { path: "src/index.ts" }], expected: 2 },
    { label: "test leak", files: [...good, { path: "dist/index.test.js" }], expected: 1 },
    { label: "missing LICENSE", files: good.filter(file => file.path !== "LICENSE"), expected: 1 },
    { label: "unexpected directory", files: [...good, { path: "examples/run.js" }], expected: 1 },
  ];
  let failures = 0;
  for (const item of cases) {
    const problems = checkFileList(item.files);
    const matched = problems.length === item.expected;
    console.log(`${matched ? "ok  " : "FAIL"}  ${item.label}: ${problems.length} problem(s)${problems.length > 0 ? ` (${problems[0]})` : ""}`);
    if (!matched) failures++;
  }
  process.exit(failures === 0 ? 0 : 1);
}

const rows = [];
let failed = false;
for (const directory of await packageDirectories()) {
  const manifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
  const label = manifest.name ?? path.basename(directory);
  // Private packages (the desktop app) are never published; npm pack would
  // still include their sources, which is not a release problem.
  if (manifest.private === true) continue;
  if (!existsSync(path.join(directory, "dist"))) {
    console.error(`error: ${label} has no dist directory; run "npm run build" first`);
    failed = true;
    continue;
  }

  let report;
  try {
    report = await pack(directory);
  } catch (cause) {
    console.error(`error: ${label}: npm pack failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    failed = true;
    continue;
  }

  const problems = [...checkFileList(report.files ?? []), ...checkExports(manifest, directory)];
  const paths = new Set((report.files ?? []).map(file => file.path));
  if (paths.size === 0) problems.push("tarball is empty");

  rows.push({
    name: label,
    version: report.version,
    files: paths.size,
    tarballBytes: report.size,
    unpackedBytes: report.unpackedSize,
    problems,
  });
  if (problems.length > 0) failed = true;
}

const width = Math.max(...rows.map(row => row.name.length), 10);
for (const row of rows) {
  const status = row.problems.length === 0 ? "ok" : "FAILED";
  console.log(
    `${row.name.padEnd(width)}  ${String(row.version).padEnd(7)}  files ${String(row.files).padEnd(3)}  ` +
    `tarball ${(row.tarballBytes / 1024).toFixed(1).padStart(7)} KB  unpacked ${(row.unpackedBytes / 1024).toFixed(1).padStart(8)} KB  ${status}`,
  );
  for (const problem of row.problems) console.log(`  - ${problem}`);
}

if (failed) {
  console.error(`\nrelease pack check failed: ${rows.filter(row => row.problems.length > 0).length} package(s) with problems`);
  process.exit(1);
}
console.log(`\nrelease pack check passed: ${rows.length} package(s)`);
