import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { declaredResources, createContainer, validateManifest } from "@weisql/sdk";
import type { ContainerFile } from "@weisql/sdk";

export interface PackOptions {
  directory: string;
  /** Output file; defaults to `<directory basename>.wsql` in the current directory. */
  output?: string;
  /** Gzip each entry and write container format 1.1.0; defaults to false. */
  compress?: boolean;
  /** Only include the Manifest and declared resources; report skipped files. */
  onlyDeclared?: boolean;
  signal?: AbortSignal;
}

export interface PackResult {
  directory: string;
  output: string;
  compressed: boolean;
  onlyDeclared: boolean;
  skipped: readonly string[];
  files: readonly { path: string; bytes: number }[];
  containerBytes: number;
}

/** Recursively collects a package directory into container entries, sorted by path. */
async function collect(directory: string, prefix: string, output: ContainerFile[], signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) throw new Error("pack was cancelled");
  const entries = await readdir(path.join(directory, prefix), { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      await collect(directory, relative, output, signal);
      continue;
    }
    if (!entry.isFile()) continue;
    output.push({ path: relative, bytes: new Uint8Array(await readFile(path.join(directory, ...relative.split("/")))) });
  }
}

/**
 * Packs a package directory into a single `.wsql` container.
 *
 * The Manifest is copied as-is, so the container is still an ordinary package
 * once extracted; `weisql validate <file>.wsql` checks exactly the same rules.
 */
export async function packPackage(options: PackOptions): Promise<PackResult> {
  const directory = path.resolve(options.directory);
  const info = await stat(directory).catch(() => undefined);
  if (info === undefined || !info.isDirectory()) throw new Error(`not a directory: ${directory}`);

  const collected: ContainerFile[] = [];
  await collect(directory, "", collected, options.signal);
  if (!collected.some(file => file.path === "manifest.json")) throw new Error("package has no manifest.json");

  let files = collected;
  let skipped: string[] = [];
  if (options.onlyDeclared === true) {
    const manifest = validateManifest(JSON.parse(new TextDecoder().decode(collected.find(file => file.path === "manifest.json")!.bytes)));
    const allowed = new Set(["manifest.json", ...declaredResources(manifest).map(resource => resource.path)]);
    const missing = [...allowed].filter(file => !collected.some(item => item.path === file));
    if (missing.length > 0) throw new Error(`declared resources are missing from the directory: ${missing.join(", ")}`);
    skipped = collected.filter(file => !allowed.has(file.path)).map(file => file.path).sort();
    files = collected.filter(file => allowed.has(file.path));
  }

  const container = await createContainer(files, { compress: options.compress === true });
  const output = path.resolve(options.output ?? `${path.basename(directory)}.wsql`);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, container);

  return {
    directory,
    output,
    compressed: options.compress === true,
    onlyDeclared: options.onlyDeclared === true,
    skipped,
    files: files.map(file => ({ path: file.path, bytes: file.bytes.byteLength })),
    containerBytes: container.byteLength,
  };
}
