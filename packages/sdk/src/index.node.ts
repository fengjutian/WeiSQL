/**
 * Node.js entry point.
 *
 * The browser entry (`index.ts`) must stay free of `node:*` imports, otherwise
 * bundlers pull `node:fs`/`node:crypto` into browser builds and fail. Node-only
 * modules are re-exported here and selected through the package's `node`
 * condition, so `import { NodeFileResourceReader } from "@weisql/sdk"` keeps
 * working in Node while `import { open } from "@weisql/sdk"` stays bundleable.
 */
export * from "./index.js";

export { NodeFileResourceReader } from "./node-file-resource-reader.js";
export type { NodeFileResourceReaderOptions } from "./node-file-resource-reader.js";

export { buildPackage } from "./builder.js";
export type { BuildArtifact, BuildPackageOptions, BuildReport, BuildStage, BuilderTableInput, BuilderVectorInput } from "./builder.js";
