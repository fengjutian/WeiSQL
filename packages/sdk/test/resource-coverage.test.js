import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildPackage, declaredResources, validateManifest } from "../dist/index.node.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SOURCE_PARQUET = path.join(REPO_ROOT, "examples", "source", "documents.parquet");
const FIXTURE_MANIFEST = path.join(REPO_ROOT, "examples", "manifest", "valid-minimal.json");

/** Walks any Manifest and collects every object shaped like a FileDescriptor. */
function collectFilePaths(value, paths = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectFilePaths(item, paths);
    return paths;
  }
  if (value !== null && typeof value === "object") {
    if (typeof value.path === "string" && typeof value.bytes === "number" && typeof value.sha256 === "string") {
      paths.add(value.path);
    }
    for (const child of Object.values(value)) collectFilePaths(child, paths);
  }
  return paths;
}

function assertCoverage(manifest) {
  const declared = new Set(declaredResources(manifest).map(resource => resource.path));
  const referenced = collectFilePaths(manifest);
  const missing = [...referenced].filter(file => !declared.has(file));
  assert.deepEqual(missing, [], "every FileDescriptor in the Manifest must be a declared resource");
  const unreferenced = [...declared].filter(file => !referenced.has(file));
  assert.deepEqual(unreferenced, [], "declaredResources must not invent paths the Manifest does not reference");
}

test("declaredResources covers every file descriptor in a built package", async (t) => {
  const temp = await mkdtemp(path.join(tmpdir(), "weisql-coverage-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const report = await buildPackage({
    outputDirectory: path.join(temp, "package"),
    datasetId: "coverage",
    tables: [{
      name: "documents",
      parquetPath: SOURCE_PARQUET,
      columns: [
        { name: "id", type: "string", nullable: false },
        { name: "title", type: "string", nullable: false },
        { name: "category", type: "string", nullable: false },
      ],
      primaryKey: ["id"],
      rowIds: ["doc-001", "doc-002", "doc-003"],
    }],
    vectorCollections: [{
      name: "document_embeddings",
      tableName: "documents",
      idColumn: "id",
      metric: "cosine",
      vectors: [[1, 0], [0.9, 0.1], [0, 1]],
      ids: ["doc-001", "doc-002", "doc-003"],
    }],
  });
  assert.ok(report.manifest.vectorCollections[0].idIndex);
  assertCoverage(report.manifest);
});

test("declaredResources covers a persisted ANN index", async () => {
  const manifest = JSON.parse(await readFile(FIXTURE_MANIFEST, "utf8"));
  const collection = manifest.vectorCollections[0];
  collection.index = {
    engine: "usearch",
    version: "2.12.0",
    file: {
      path: "vectors/ann.usearch",
      bytes: 1024,
      sha256: "0".repeat(64),
    },
  };
  assertCoverage(validateManifest(manifest));
});
