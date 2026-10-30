/**
 * Static release checks for the workspace packages.
 *
 *   npm run release:check
 *
 * It verifies packaging metadata rather than behaviour: version shape, workspace
 * dependency ranges, publishable file lists, and whether the build output that
 * `files` promises actually exists. Behaviour is covered by `npm test`.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

const errors = [];
const warnings = [];

function fail(message) {
  errors.push(message);
}

function warn(message) {
  warnings.push(message);
}

function readJson(file) {
  // Windows editors and some tools write a UTF-8 BOM; JSON.parse rejects it.
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

const root = readJson(path.join(REPO_ROOT, "package.json"));
const workspaceDirectories = readdirSync(path.join(REPO_ROOT, "packages"), { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .filter(entry => existsSync(path.join(REPO_ROOT, "packages", entry.name, "package.json")))
  .map(entry => entry.name)
  .sort();

const packages = workspaceDirectories.map(directory => {
  const file = path.join(REPO_ROOT, "packages", directory, "package.json");
  return { directory, file, manifest: readJson(file) };
});

const versions = new Map(packages.map(entry => [entry.manifest.name, entry.manifest.version]));

for (const { directory, manifest } of packages) {
  const label = manifest.name ?? directory;

  if (typeof manifest.name !== "string" || !manifest.name.startsWith("@weisql/")) {
    fail(`${label}: package name must be scoped as @weisql/*`);
  }
  if (manifest.private === true) fail(`${label}: publishable packages must not be private`);
  if (typeof manifest.version !== "string" || !SEMVER.test(manifest.version)) {
    fail(`${label}: version '${manifest.version}' is not semver`);
  }
  if (typeof manifest.description !== "string" || manifest.description.length === 0) {
    warn(`${label}: missing description`);
  }

  const files = manifest.files ?? [];
  if (!files.includes("dist")) fail(`${label}: "files" must include dist`);
  if (files.some(entry => entry.startsWith("src"))) fail(`${label}: "files" must not publish src`);

  for (const key of ["main", "types"]) {
    const value = manifest[key];
    if (typeof value !== "string" || !value.startsWith("./dist/")) {
      fail(`${label}: ${key} must point inside ./dist`);
    }
  }
  const exported = manifest.exports?.["."];
  if (exported === undefined) fail(`${label}: missing "." export`);
  else {
    for (const key of ["types", "import"]) {
      const value = exported[key];
      if (typeof value !== "string" || !value.startsWith("./dist/")) fail(`${label}: exports["."].${key} must point inside ./dist`);
    }
  }

  if (manifest.publishConfig?.registry === undefined) {
    warn(`${label}: no publishConfig.registry (fine for public npm, required for a private registry)`);
  }

  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!dependency.startsWith("@weisql/")) continue;
    const localVersion = versions.get(dependency);
    if (localVersion === undefined) {
      fail(`${label}: depends on ${dependency}, which is not a workspace package`);
      continue;
    }
    if (range === "*" || range === "latest") {
      fail(`${label}: dependency ${dependency} must use a caret range, not '${range}'`);
      continue;
    }
    const expectedPrefix = `^${localVersion.split(".")[0]}.${localVersion.split(".")[1]}.`;
    if (!range.startsWith(expectedPrefix)) {
      fail(`${label}: dependency ${dependency} range '${range}' does not track local version ${localVersion}`);
    }
  }

  if (!existsSync(path.join(REPO_ROOT, "packages", directory, "dist", "index.js"))) {
    warn(`${label}: dist/index.js is missing — run "npm run build" before packing`);
  }
  if (!existsSync(path.join(REPO_ROOT, "packages", directory, "README.md"))) {
    fail(`${label}: missing README.md (npm shows it on the package page)`);
  }
}

if (!existsSync(path.join(REPO_ROOT, "LICENSE"))) {
  warn("no LICENSE at the repository root; publishing without one is a legal decision, not a default");
}
if (!existsSync(path.join(REPO_ROOT, "CHANGELOG.md"))) {
  warn("no CHANGELOG.md; release notes would have to be written from scratch");
}

const summary = {
  workspace: root.name,
  packages: packages.map(({ manifest }) => `${manifest.name}@${manifest.version}`),
  errors,
  warnings,
};

console.log(JSON.stringify(summary, null, 2));
if (errors.length > 0) {
  console.error(`release check failed: ${errors.length} error(s), ${warnings.length} warning(s)`);
  process.exit(1);
}
console.log(`release check passed: 0 error(s), ${warnings.length} warning(s)`);
