/**
 * Packs the publishable packages, installs the tarballs into a throwaway project
 * and runs a small SDK + DuckDB adapter smoke test against the example fixture.
 *
 *   npm run release:e2e
 *
 * This catches packaging mistakes that `release:check` cannot see: missing
 * `dist` files, broken `exports`, undeclared runtime dependencies. It needs
 * registry access for `@duckdb/node-api`, so it is not part of the default test
 * run.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = path.join(REPO_ROOT, "examples", "fixture");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const NPM_CLI = process.env.npm_execpath;
const runNpm = (args, options) => NPM_CLI !== undefined && NPM_CLI.endsWith(".js")
  ? run(process.execPath, [NPM_CLI, ...args], options)
  : run(NPM, args, { ...options, shell: process.platform === "win32" });

const directory = await mkdtemp(path.join(tmpdir(), "weisql-pack-e2e-"));
try {
  await runNpm(["pack", "./packages/sdk", "./packages/duckdb-adapter", "--pack-destination", directory], { cwd: REPO_ROOT, stdio: "ignore" });
  const sdk = path.join(directory, "weisql-sdk-0.1.0.tgz");
  const adapter = path.join(directory, "weisql-duckdb-adapter-0.1.0.tgz");
  await writeFile(path.join(directory, "package.json"), '{"name":"weisql-pack-e2e","private":true,"type":"module"}\n');
  await writeFile(path.join(directory, "e2e.mjs"), `import { readFile } from "node:fs/promises";
import path from "node:path";
import { open, NodeFileResourceReader } from "@weisql/sdk";
import { createDuckDbAdapter } from "@weisql/duckdb-adapter";

const fixture = ${JSON.stringify(FIXTURE)};
const manifest = JSON.parse(await readFile(path.join(fixture, "manifest.json"), "utf8"));
const db = await open({
  manifest,
  resourceReader: new NodeFileResourceReader({ rootDirectory: fixture }),
  verifyChecksums: "all",
  sqlAdapter: createDuckDbAdapter(),
});
const rows = await db.sql("select id, title from documents order by id");
const hits = await db.vector.search("document_embeddings", [1, 0], { topK: 2 });
const streamed = [];
for await (const row of await db.sqlStream("select id from documents order by id")) streamed.push(row.id);
await db.close();
console.log(JSON.stringify({ rows: rows.length, firstTitle: rows[0].title, topIds: hits.map(hit => hit.id), streamed }));
`);
  await runNpm(["install", "--no-audit", "--no-fund", sdk, adapter], { cwd: directory, stdio: "ignore" });
  const { stdout } = await run(process.execPath, ["e2e.mjs"], { cwd: directory });
  const result = JSON.parse(stdout.trim().split("\n").at(-1));
  if (result.rows !== 3 || result.topIds?.[0] !== "doc-001" || result.streamed?.length !== 3) {
    throw new Error(`unexpected result: ${JSON.stringify(result)}`);
  }
  console.log(`release:e2e passed: ${JSON.stringify(result)}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
