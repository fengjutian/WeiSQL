/**
 * Builds the package the parity probe serves.
 *
 * The committed fixture has no text index (derived indexes are not committed), so
 * the probe copies it, builds the index with the real generator, and packs a
 * `.wsql` container. Both environments therefore read the exact same bytes.
 */
import { execFile } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const FIXTURE = path.join(REPO_ROOT, "examples", "fixture");

export async function prepareProbePackage() {
  const directory = await mkdtemp(path.join(tmpdir(), "weisql-parity-"));
  const packageDirectory = path.join(directory, "package");
  await cp(FIXTURE, packageDirectory, { recursive: true });

  await run(process.execPath, [
    path.join(REPO_ROOT, "tools", "build-text-index.mjs"),
    packageDirectory,
    "--table", "documents",
    "--column", "title",
  ]);

  const containerPath = path.join(directory, "package.wsql");
  await run(process.execPath, [
    path.join(REPO_ROOT, "packages", "cli", "dist", "bin.js"),
    "pack", packageDirectory,
    "--output", containerPath,
  ]);

  return {
    packageDirectory,
    containerPath,
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}
