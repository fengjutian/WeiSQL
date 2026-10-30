/**
 * Rebuilds `examples/fixture` from the immutable source Parquet.
 *
 * The fixture is the smallest human-checkable package described by
 * `docs/E2E_ACCEPTANCE_PLAN.md`: three documents, one 2-dimensional cosine
 * collection. Run it from the repository root:
 *
 *     npm run fixture
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPackage } from "../packages/sdk/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const report = await buildPackage({
  outputDirectory: path.join(root, "examples", "fixture"),
  overwrite: true,
  datasetId: "demo-documents",
  metadata: {
    title: "WeiSQL AI E2E fixture",
    description: "Three documents with 2-dimensional cosine embeddings",
    createdAt: "2026-10-30T00:00:00Z",
  },
  tables: [
    {
      name: "documents",
      parquetPath: path.join(root, "examples", "source", "documents.parquet"),
      columns: [
        { name: "id", type: "string", nullable: false },
        { name: "title", type: "string", nullable: false },
        { name: "category", type: "string", nullable: false },
      ],
      primaryKey: ["id"],
      rowIds: ["doc-001", "doc-002", "doc-003"],
    },
  ],
  vectorCollections: [
    {
      name: "document_embeddings",
      tableName: "documents",
      idColumn: "id",
      metric: "cosine",
      vectors: [
        [1, 0],
        [0.9, 0.1],
        [0, 1],
      ],
      ids: ["doc-001", "doc-002", "doc-003"],
    },
  ],
});

console.log(`published ${report.artifacts.length} files in ${report.outputDirectory}`);
console.log(`integrity: ${report.integrity.checkedResources} checked, ${report.integrity.hashesVerified} hashed`);
for (const artifact of report.artifacts) {
  console.log(`  ${artifact.path.padEnd(34)} ${String(artifact.bytes).padStart(6)} B  ${artifact.sha256}`);
}
