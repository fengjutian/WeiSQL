import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

// `@weisql/sdk` re-exports its Node-only file reader and builder. The desktop
// UI never uses them, but Rollup still has to resolve their `node:` imports, so
// they are pointed at a shim that is tree-shaken away with the unused modules.
const nodeShim = fileURLToPath(new URL("./src/node-shim.ts", import.meta.url));

// Tauri serves the built assets from `dist`; a relative base keeps the bundle
// working under the custom protocol used in production.
export default defineConfig({
  base: "./",
  clearScreen: false,
  resolve: {
    alias: [
      { find: /^node:fs\/promises$/, replacement: nodeShim },
      { find: /^node:fs$/, replacement: nodeShim },
      { find: /^node:path$/, replacement: nodeShim },
      { find: /^node:crypto$/, replacement: nodeShim },
    ],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
  },
  build: {
    target: "es2022",
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
