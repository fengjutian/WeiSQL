import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { ContainerReader, assertSafeContainerPath } from "@weisql/sdk";

export interface UnpackOptions {
  /** Container file to extract. */
  file: string;
  /** Output directory; created when missing. */
  directory: string;
  signal?: AbortSignal;
}

export interface UnpackResult {
  file: string;
  directory: string;
  files: readonly string[];
  bytes: number;
  digestsVerified: number;
}

/**
 * Extracts a `.wsql` container after verifying every entry.
 *
 * Digests are checked **before** anything is written, so a tampered container
 * cannot leave a partially trusted directory behind. Entry paths are validated
 * again here because a container header is untrusted input.
 */
export async function unpackContainer(options: UnpackOptions): Promise<UnpackResult> {
  const file = path.resolve(options.file);
  const directory = path.resolve(options.directory);

  const reader = new ContainerReader(new Uint8Array(await readFile(file)));
  try {
    const mismatches = await reader.verify();
    if (mismatches.length > 0) {
      throw new Error(`container digests do not match: ${mismatches.map(mismatch => mismatch.path).join(", ")}`);
    }

    const files: string[] = [];
    let bytes = 0;
    for (const entry of reader.header.files) {
      if (options.signal?.aborted) throw new Error("unpack was cancelled");
      assertSafeContainerPath(entry.path);
      const target = path.resolve(directory, ...entry.path.split("/"));
      if (target !== directory && !target.startsWith(`${directory}${path.sep}`)) {
        throw new Error(`refusing to write outside the output directory: ${entry.path}`);
      }
      const content = await reader.read(entry.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
      files.push(entry.path);
      bytes += content.byteLength;
    }

    return { file, directory, files, bytes, digestsVerified: reader.header.files.length };
  } finally {
    await reader.close();
  }
}
