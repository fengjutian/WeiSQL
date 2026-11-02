/**
 * Builds every runnable framework example and smoke-tests it in Chromium.
 *
 *   npm run test:frameworks
 *
 * Prerequisites: `npm run build` at the repository root (the SDK dist is imported
 * through a file: dependency) and installed app dependencies.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { smokeApp } from "./smoke.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SDK_DIST = path.join(REPO_ROOT, "packages", "sdk", "dist", "index.js");

/** Add an entry here when another framework app lands. */
const APPS = [
  {
    name: "vite-react",
    directory: path.join(HERE, "vite-react"),
  },
];

const run = (command, args, cwd) => {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed in ${path.relative(REPO_ROOT, cwd)}`);
  }
};

if (!existsSync(SDK_DIST)) {
  console.error("packages/sdk/dist is missing. Run `npm run build` at the repository root first.");
  process.exit(2);
}

run(process.execPath, [path.join(HERE, "sync-fixture.mjs")], REPO_ROOT);

for (const app of APPS) {
  const installed = existsSync(path.join(app.directory, "node_modules"));
  if (!installed) {
    console.error(`Dependencies missing in ${app.name}. Run: npm --prefix "${app.directory}" install`);
    process.exit(2);
  }

  const distDirectory = path.join(app.directory, "dist");
  console.log(`\n[${app.name}] building`);
  run("npm", ["run", "build"], app.directory);

  const built = await stat(distDirectory).then(() => true).catch(() => false);
  if (!built) throw new Error(`[${app.name}] dist/ was not produced`);

  console.log(`[${app.name}] smoke test`);
  await smokeApp({
    name: app.name,
    distDirectory,
    expectedIds: 3,
  });
}

console.log("\nframeworks: all apps passed");
