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
const REPOSITORY_URL = "git+https://github.com/fengjutian/WeiSQL.git";

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
  // Scoped packages default to restricted (paid) visibility. Relying on the
  // `--access public` flag of a single command is a footgun: a forgotten flag
  // turns a release into an error, or worse, an accidental private publish.
  if (manifest.publishConfig?.access !== "public") {
    fail(`${label}: publishConfig.access must be "public" (scoped packages default to restricted)`);
  }
  if (manifest.repository?.url !== REPOSITORY_URL) {
    fail(`${label}: repository.url must be ${REPOSITORY_URL}`);
  }
  if (manifest.repository?.directory !== `packages/${directory}`) {
    fail(`${label}: repository.directory must be packages/${directory}`);
  }
  if (typeof manifest.homepage !== "string" || manifest.homepage.length === 0) {
    warn(`${label}: missing homepage (the npm page links nowhere without it)`);
  }
  if (!Array.isArray(manifest.keywords) || manifest.keywords.length === 0) {
    warn(`${label}: missing keywords (npm search cannot find the package by topic)`);
  }
  if (typeof manifest.license !== "string" || manifest.license.length === 0) {
    fail(`${label}: missing license field (decided: Apache-2.0)`);
  } else if (manifest.license !== "Apache-2.0") {
    fail(`${label}: license '${manifest.license}' does not match the decided Apache-2.0`);
  }

  const checkWorkspaceRange = (kind, dependency, range) => {
    const localVersion = versions.get(dependency);
    if (localVersion === undefined) {
      fail(`${label}: ${kind} ${dependency} is not a workspace package`);
      return;
    }
    if (range === "*" || range === "latest") {
      fail(`${label}: ${kind} ${dependency} must use a caret range, not '${range}'`);
      return;
    }
    const expectedPrefix = `^${localVersion.split(".")[0]}.${localVersion.split(".")[1]}.`;
    if (!range.startsWith(expectedPrefix)) {
      fail(`${label}: ${kind} ${dependency} range '${range}' does not track local version ${localVersion}`);
    }
  };

  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (!dependency.startsWith("@weisql/")) continue;
    checkWorkspaceRange("dependency", dependency, range);
  }
  for (const [dependency, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (!dependency.startsWith("@weisql/")) continue;
    checkWorkspaceRange("peer dependency", dependency, range);
  }

  if (!existsSync(path.join(REPO_ROOT, "packages", directory, "dist", "index.js"))) {
    warn(`${label}: dist/index.js is missing — run "npm run build" before packing`);
  }
  if (!existsSync(path.join(REPO_ROOT, "packages", directory, "README.md"))) {
    fail(`${label}: missing README.md (npm shows it on the package page)`);
  }
}

if (!existsSync(path.join(REPO_ROOT, "LICENSE"))) {
  fail("no LICENSE at the repository root; Apache-2.0 was decided, so the file must exist");
} else if (!readFileSync(path.join(REPO_ROOT, "LICENSE"), "utf8").includes("Apache License")) {
  fail("LICENSE does not contain the Apache License text");
}
if (typeof root.license !== "string" || root.license !== "Apache-2.0") {
  fail(`root package.json must declare license 'Apache-2.0'`);
}
if (existsSync(path.join(REPO_ROOT, "LICENSE")) && packages.length > 0) {
  for (const { directory } of packages) {
    if (!existsSync(path.join(REPO_ROOT, "packages", directory, "LICENSE"))) {
      fail(`${directory}: no LICENSE file inside the package; npm only ships a license that exists in the package directory`);
    }
  }
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
