/**
 * Serves the playground for manual use.
 *
 *   npm run playground      # http://127.0.0.1:8099/playground/
 *
 * The committed fixture has no text index, so a temporary package copy with a
 * generated index is served instead; the repository stays free of derived files.
 */
import { ensureParquetExtension } from "../fetch-duckdb-wasm-extension.mjs";
import { prepareProbePackage } from "./prepare-package.mjs";
import { createProbeServer } from "./server.mjs";

const port = Number(process.env.PORT ?? 8099);
const probePackage = await prepareProbePackage();
// The playground's SQL panel needs the same-origin parquet extension; fetch it
// once here so the first SQL click does not fail for a missing file.
const extension = await ensureParquetExtension("wasm_eh").catch((cause) => {
  console.warn(`parquet extension unavailable, SQL panel will fail: ${String(cause)}`);
  return undefined;
});
const probe = createProbeServer(probePackage.packageDirectory, probePackage.containerPath);
const bound = await probe.listen(port);
console.log(`playground: http://127.0.0.1:${bound}/playground/`);
if (extension !== undefined) console.log(`parquet extension: ${extension}`);
console.log("press Ctrl+C to stop");

const shutdown = async () => {
  await probe.close();
  await probePackage.cleanup();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
