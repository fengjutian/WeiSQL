import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import { ContainerReader, declaredResources, manifestSignatures, validateManifest, verifyManifestSignature } from "@weisql/sdk";
import type { WeiSQLManifest, VerifyManifestSignatureResult } from "@weisql/sdk";

export interface InspectTable {
  name: string;
  columns: number;
  bytes: number;
}

export interface InspectVector {
  name: string;
  count: number;
  dimension: number;
  metric: string;
  bytes: number;
  persistedIndex: boolean;
}

export interface InspectTextIndex {
  name: string;
  documents: number;
  terms: number;
  bytes: number;
  hasDocuments: boolean;
}

export interface InspectResult {
  target: string;
  kind: "directory" | "container";
  datasetId: string;
  formatVersion: string;
  tables: InspectTable[];
  vectors: InspectVector[];
  textIndexes: InspectTextIndex[];
  signature: VerifyManifestSignatureResult & { present: boolean };
  resources: {
    files: number;
    declaredBytes: number;
    declaredFiles: number;
    /** Files present on disk but not declared by the Manifest (directory only). */
    undeclared: string[];
  };
  container?: { files: number; compression?: string };
}

/** Summarizes a package without opening a Runtime; also lists undeclared files. */
export async function inspectPackage(target: string): Promise<InspectResult> {
  const resolved = path.resolve(target);
  const isContainer = path.extname(resolved).toLowerCase() === ".wsql";

  let manifest: WeiSQLManifest;
  let presentFiles: Set<string>;
  let sizes: Map<string, number>;
  let container: InspectResult["container"];

  if (isContainer) {
    const reader = new ContainerReader(new Uint8Array(await readFile(resolved)));
    try {
      manifest = validateManifest(JSON.parse(new TextDecoder().decode(await reader.read("manifest.json"))));
      presentFiles = new Set(reader.header.files.map(entry => entry.path));
      sizes = new Map(reader.header.files.map(entry => [entry.path, entry.bytes]));
      container = {
        files: reader.header.files.length,
        ...(reader.header.compression === undefined ? {} : { compression: reader.header.compression }),
      };
    } finally {
      await reader.close();
    }
  } else {
    manifest = validateManifest(JSON.parse(await readFile(path.join(resolved, "manifest.json"), "utf8")));
    const entries = await walk(resolved);
    presentFiles = new Set(entries.map(entry => entry.path));
    sizes = new Map(entries.map(entry => [entry.path, entry.bytes]));
  }

  const declared = declaredResources(manifest);
  const declaredPaths = new Set(declared.map(resource => resource.path));
  const undeclared = [...presentFiles].filter(file => file !== "manifest.json" && !declaredPaths.has(file)).sort();

  const signature = manifestSignatures(manifest).length === 0
    ? { present: false, valid: false as const, keyIds: [] as string[], signatures: [], trustedKeyIds: [] as string[], reason: "missing-signature" as const }
    : { present: true, ...(await verifyManifestSignature(manifest)) };

  return {
    target: resolved,
    kind: isContainer ? "container" : "directory",
    datasetId: manifest.datasetId,
    formatVersion: manifest.formatVersion,
    tables: manifest.tables.map(table => ({
      name: table.name,
      columns: table.columns.length,
      bytes: table.file.bytes,
    })),
    vectors: manifest.vectorCollections.map(collection => ({
      name: collection.name,
      count: collection.count,
      dimension: collection.dimension,
      metric: collection.metric,
      bytes: collection.data.bytes,
      persistedIndex: collection.index !== undefined,
    })),
    textIndexes: (manifest.textIndexes ?? []).map(index => ({
      name: index.name,
      documents: index.documentCount,
      terms: index.termCount,
      bytes: index.data.bytes + index.termOffsets.bytes + index.docLengths.bytes + index.idMap.data.bytes + index.idMap.offsets.bytes,
      hasDocuments: index.documents !== undefined,
    })),
    signature,
    resources: {
      files: presentFiles.size,
      declaredBytes: declared.reduce((sum, resource) => sum + resource.bytes, 0),
      declaredFiles: declared.length,
      undeclared,
    },
    ...(container === undefined ? {} : { container }),
  };
}

async function walk(root: string, prefix = ""): Promise<{ path: string; bytes: number }[]> {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files: { path: string; bytes: number }[] = [];
  for (const entry of entries) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await walk(root, relative));
      continue;
    }
    if (!entry.isFile()) continue;
    const info = await stat(path.join(root, ...relative.split("/")));
    files.push({ path: relative, bytes: info.size });
  }
  return files;
}
