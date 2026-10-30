/**
 * Serves the playground for manual use.
 *
 *   npm run playground      # http://127.0.0.1:8099/playground/
 */
import { createProbeServer } from "./server.mjs";

const port = Number(process.env.PORT ?? 8099);
const probe = createProbeServer();
const bound = await probe.listen(port);
console.log(`playground: http://127.0.0.1:${bound}/playground/`);
console.log("press Ctrl+C to stop");
