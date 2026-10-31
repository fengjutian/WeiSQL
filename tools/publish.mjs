#!/usr/bin/env node
/**
 * Publishes the @weisql/* workspace packages in dependency order.
 *
 *   node tools/publish.mjs                     # dry run, nothing is published
 *   node tools/publish.mjs --apply             # publish (irreversible)
 *   node tools/publish.mjs --apply --otp 123456
 *   node tools/publish.mjs --apply --tag next
 *
 * Why a script instead of five hand-typed commands:
 *  - SDK must be on the registry before the packages that depend on it;
 *  - `npm publish` cannot be undone, so the version, the dist output and the
 *    registry state are checked *before* the first package leaves the machine;
 *  - a partial publish (2 of 5) is the worst outcome, so every check runs up
 *    front and the first failure stops the run.
 *
 * `publishConfig.access` is set in every package, so `--access public` is not
 * passed here: a forgotten flag would otherwise turn into a failed (or
 * accidentally restricted) release. See docs/RELEASE_PROCESS.md.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PREFERRED_ORDER = [
  "@weisql/sdk",
  "@weisql/duckdb-adapter",
  "@weisql/duckdb-wasm-adapter",
  "@weisql/usearch-adapter",
  "@weisql/cli",
];

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const tag = flagValue("--tag") ?? "latest";
const otp = flagValue("--otp");

function flagValue(flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(
    [
      "Usage: node tools/publish.mjs [--apply] [--tag <dist-tag>] [--otp <code>]",
      "",
      "  (no flags)   dry run: preflight + `npm publish --dry-run` for every package",
      "  --apply      publish for real; the order is fixed and the first error stops the run",
      "  --tag        dist-tag, defaults to `latest`",
      "  --otp        one-time password when the account requires 2FA",
      "",
      "Requires an authenticated npm CLI: run `npm login` or set NODE_AUTH_TOKEN.",
    ].join("\n"),
  );
  process.exit(0);
}

// Same invocation strategy as tools/check-tarballs.mjs: prefer the npm CLI
// script next to the running Node binary so no shell is involved.
const NPM_CLI = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
const USE_NPM_CLI = existsSync(NPM_CLI);

function npm(npmArgs, options = {}) {
  return spawnSync(
    USE_NPM_CLI ? process.execPath : "npm",
    USE_NPM_CLI ? [NPM_CLI, ...npmArgs] : npmArgs,
    { cwd: ROOT, encoding: "utf8", shell: !USE_NPM_CLI, ...options },
  );
}

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function loadPackages() {
  const parent = path.join(ROOT, "packages");
  return readdirSync(parent, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .filter(entry => existsSync(path.join(parent, entry.name, "package.json")))
    .map(entry => {
      const manifest = readJson(path.join(parent, entry.name, "package.json"));
      return {
        directory: entry.name,
        name: manifest.name,
        version: manifest.version,
        files: manifest.files ?? [],
        dependencies: manifest.dependencies ?? {},
        peerDependencies: manifest.peerDependencies ?? {},
        peerDependenciesMeta: manifest.peerDependenciesMeta ?? {},
        dist: path.join(parent, entry.name, "dist"),
      };
    });
}

/**
 * Dependency order for the packages on this workspace. Only hard dependencies
 * and non-optional peers constrain the order; an optional peer (the CLI's
 * DuckDB adapter) must not force a package to wait, otherwise a future
 * optional-only package could deadlock the graph.
 */
function publishOrder(packages) {
  const byName = new Map(packages.map(entry => [entry.name, entry]));
  const rank = name => {
    const index = PREFERRED_ORDER.indexOf(name);
    return index === -1 ? PREFERRED_ORDER.length : index;
  };
  const ordered = [];
  const visiting = new Set();
  const visit = entry => {
    if (ordered.includes(entry) || visiting.has(entry.name)) return;
    visiting.add(entry.name);
    const required = [
      ...Object.keys(entry.dependencies),
      ...Object.keys(entry.peerDependencies).filter(
        dependency => entry.peerDependenciesMeta?.[dependency]?.optional !== true,
      ),
    ];
    for (const dependency of required) {
      const target = byName.get(dependency);
      if (target !== undefined) visit(target);
    }
    visiting.delete(entry.name);
    ordered.push(entry);
  };
  [...packages].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name)).forEach(visit);
  return ordered;
}

function truncate(text, limit = 240) {
  const compact = String(text ?? "").replace(/\s+/g, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit)}...` : compact;
}

function whoami() {
  const result = npm(["whoami"]);
  return result.status === 0 ? result.stdout.trim() : null;
}

/**
 * Ask the registry whether this exact version exists. A 404 is the only answer
 * that proves the version is free; any other failure means the state is unknown
 * and a real publish would most likely fail too, so it must not be ignored.
 */
function registryState(name, version) {
  const result = npm(["view", `${name}@${version}`, "version", "--json"]);
  if (result.status === 0) return { state: "published", detail: truncate(result.stdout) };
  const stderr = `${result.stderr ?? ""}`;
  if (/E404|404 Not Found|is not in this registry/i.test(stderr)) return { state: "free" };
  return { state: "unknown", detail: truncate(stderr.split("\n").find(line => line.trim())) };
}

const packages = publishOrder(loadPackages());
const problems = [];
const warnings = [];

console.log(apply ? "MODE: APPLY — packages will be published for real" : "MODE: DRY RUN — nothing is published (pass --apply to publish)");
console.log(`dist-tag: ${tag}${otp === undefined ? "" : "   otp: provided"}\n`);

const user = whoami();
if (user === null) {
  const message =
    "npm CLI is not authenticated (`npm whoami` failed). Run `npm login`, or set NODE_AUTH_TOKEN " +
    "to a token that can publish to the @weisql scope.";
  if (apply) problems.push(message);
  else warnings.push(`${message} (dry run continues)`);
} else {
  console.log(`authenticated as: ${user}`);
  const organization = packages[0]?.name.split("/")[0].replace(/^@/, "");
  if (organization !== undefined) {
    const orgCheck = npm(["org", "ls", organization, "--json"]);
    if (orgCheck.status !== 0) {
      warnings.push(
        `cannot confirm that the "@${organization}" scope exists and that you belong to it; ` +
          "publishing to a scope you do not own fails with 403/404",
      );
    }
  }
}

const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: ROOT, encoding: "utf8" });
if (dirty.status === 0 && dirty.stdout.trim() !== "") {
  warnings.push("working tree is not clean; the published tarball will not match any commit unless you commit first");
}

console.log("");
const rows = [];
for (const entry of packages) {
  const row = { name: entry.name, version: entry.version, state: "", note: "" };
  if (entry.files.length === 0 || !entry.files.includes("dist")) {
    problems.push(`${entry.name}: "files" must include dist`);
    row.state = "BAD METADATA";
  } else if (!existsSync(path.join(entry.dist, "index.js"))) {
    problems.push(`${entry.name}: dist/index.js is missing; run "npm run build" before publishing`);
    row.state = "NO DIST";
  } else {
    const registry = registryState(entry.name, entry.version);
    row.state = registry.state === "free" ? "free" : registry.state === "published" ? "ALREADY PUBLISHED" : "UNKNOWN";
    row.note = registry.detail ?? "";
    if (registry.state === "published") {
      problems.push(
        `${entry.name}@${entry.version} is already on the registry; published versions are immutable — bump the version (docs/RELEASE_PROCESS.md §2)`,
      );
    } else if (registry.state === "unknown") {
      const message = `${entry.name}: cannot read registry state (${row.note || "npm view failed"})`;
      if (apply) problems.push(message);
      else warnings.push(message);
    }
  }
  rows.push(row);
}

const nameWidth = Math.max(...rows.map(row => row.name.length), 10);
for (const row of rows) {
  console.log(
    `${row.name.padEnd(nameWidth)}  ${row.version.padEnd(7)}  ${row.state}${row.note === "" ? "" : `  (${row.note})`}`,
  );
}

for (const warning of warnings) console.warn(`\nwarning: ${warning}`);
if (problems.length > 0) {
  console.error(`\npreflight failed: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`\npreflight passed: ${packages.length} package(s), publish order above`);

const publishArgs = ["publish", "--tag", tag, ...(otp === undefined ? [] : ["--otp", otp])];
if (!apply) {
  console.log("\nDry-run output (npm publish --dry-run), one package at a time:\n");
  for (const entry of packages) {
    console.log(`--- ${entry.name}@${entry.version} ---`);
    const result = npm([...publishArgs, "--dry-run", "--workspace", entry.name], { stdio: "inherit" });
    if (result.status !== 0) {
      console.error(`dry run failed for ${entry.name}`);
      process.exit(result.status ?? 1);
    }
  }
  console.log("\nDry run passed. Re-run with --apply to publish, in the order shown above.");
  process.exit(0);
}

const published = [];
for (const entry of packages) {
  console.log(`\n--- publishing ${entry.name}@${entry.version} ---`);
  const result = npm([...publishArgs, "--workspace", entry.name], { stdio: "inherit" });
  if (result.status !== 0) {
    console.error(`\nFAILED while publishing ${entry.name}@${entry.version}.`);
    if (published.length > 0) {
      console.error(`Already published (do not retry these): ${published.join(", ")}`);
    }
    if (published.length < packages.length) {
      console.error(
        "Remaining packages are NOT published. npm versions are immutable: fix the cause, then bump the " +
          "version of every package that still has to go out, or publish the rest by hand.",
      );
    }
    process.exit(result.status ?? 1);
  }
  published.push(`${entry.name}@${entry.version}`);
}

console.log(`\npublished ${published.length} package(s):\n  ${published.join("\n  ")}`);
console.log(
  [
    "",
    "Next: verify from a clean directory (docs/RELEASE_PROCESS.md §5):",
    "  mkdir /tmp/weisql-install && cd /tmp/weisql-install",
    "  npm init -y && npm i @weisql/sdk @weisql/cli",
    "  npx weisql validate <a real data package> --l4",
  ].join("\n"),
);
