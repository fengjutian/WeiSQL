/**
 * Copies the committed fixture into every example's static directory.
 *
 * The data package is generated output: it must never be committed twice, and
 * `examples/fixture` stays the single source of truth.
 */
import { cp, mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SOURCE = path.join(REPO_ROOT, "examples", "fixture");

/** Every app that serves the package from its own static directory. */
const TARGETS = [
  path.join(HERE, "vite-react", "public", "datasets", "demo"),
  path.join(HERE, "sveltekit", "static", "datasets", "demo"),
];

const sourceExists = await stat(SOURCE).then(() => true).catch(() => false);
if (!sourceExists) {
  console.error(`Missing fixture: ${SOURCE}. Run "npm run fixture" first.`);
  process.exit(1);
}

for (const target of TARGETS) {
  const appDirectory = path.resolve(target, "..", "..", "..");
  const appExists = await stat(appDirectory).then(() => true).catch(() => false);
  if (!appExists) continue;

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  await cp(SOURCE, target, { recursive: true });
  console.log(`fixture -> ${path.relative(REPO_ROOT, target)}`);
}
