/**
 * Serves the playground for manual use.
 *
 *   npm run playground      # http://127.0.0.1:8099/playground/
 *
 * The committed fixture has no text index, so a temporary package copy with a
 * generated index is served instead; the repository stays free of derived files.
 */
import { prepareProbePackage } from "./prepare-package.mjs";
import { createProbeServer } from "./server.mjs";

const port = Number(process.env.PORT ?? 8099);
const probePackage = await prepareProbePackage();
const probe = createProbeServer(probePackage.packageDirectory, probePackage.containerPath);
const bound = await probe.listen(port);
console.log(`playground: http://127.0.0.1:${bound}/playground/`);
console.log("press Ctrl+C to stop");

const shutdown = async () => {
  await probe.close();
  await probePackage.cleanup();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
