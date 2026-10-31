/**
 * Static server for the browser probe.
 *
 * Serves the built SDK and the example package, and records every Range request
 * so the probe can prove that the browser read the package in ranges instead of
 * downloading whole files. CORS headers are always sent, which is what a CDN
 * deployment must do for `Content-Range` and friends.
 */
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const SDK_DIST = path.join(REPO_ROOT, "packages", "sdk", "dist");
const WASM_ADAPTER_DIST = path.join(REPO_ROOT, "packages", "duckdb-wasm-adapter", "dist");
const EXTENSION_CACHE = path.join(REPO_ROOT, ".cache", "duckdb-wasm-extensions");
const DEFAULT_FIXTURE = path.join(REPO_ROOT, "examples", "fixture");
const PLAYGROUND = path.join(REPO_ROOT, "examples", "playground");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".parquet": "application/octet-stream",
  ".f32": "application/octet-stream",
  ".jsonl": "application/json; charset=utf-8",
  ".offsets": "application/octet-stream",
};

export function createProbeServer(fixtureDirectory = DEFAULT_FIXTURE, containerPath = undefined) {
  const rangeLog = [];

  const resolveTarget = (urlPath) => {
    if (urlPath === "/" || urlPath === "/index.html" || urlPath === "/sdk.html") return path.join(HERE, "sdk.html");
    if (urlPath === "/wasm" || urlPath === "/wasm.html") return path.join(HERE, "wasm.html");
    if (urlPath === "/wasm-stream-bench" || urlPath === "/wasm-stream-bench.html") return path.join(HERE, "wasm-stream-bench.html");
    if (urlPath === "/wasm-parquet-bench" || urlPath === "/wasm-parquet-bench.html") return path.join(HERE, "wasm-parquet-bench.html");
    if (urlPath === "/playground" || urlPath === "/playground/") return path.join(PLAYGROUND, "index.html");
    if (urlPath === "/parity" || urlPath === "/parity/") return path.join(HERE, "parity.html");
    if (urlPath === "/container.wsql") return containerPath;
    if (urlPath.startsWith("/parity/")) return path.join(HERE, urlPath.slice("/parity/".length));
    if (urlPath.startsWith("/playground/")) return path.join(PLAYGROUND, urlPath.slice("/playground/".length));
    if (urlPath.startsWith("/sdk/")) return path.join(SDK_DIST, urlPath.slice("/sdk/".length));
    if (urlPath.startsWith("/wasm-adapter/")) return path.join(WASM_ADAPTER_DIST, urlPath.slice("/wasm-adapter/".length));
    if (urlPath.startsWith("/extensions/")) return path.join(EXTENSION_CACHE, urlPath.slice("/extensions/".length));
    if (urlPath.startsWith("/vendor/")) {
      const target = path.resolve(REPO_ROOT, "node_modules", urlPath.slice("/vendor/".length));
      const root = path.join(REPO_ROOT, "node_modules") + path.sep;
      return target.startsWith(root) ? target : undefined;
    }
    if (urlPath.startsWith("/fixture/")) return path.join(fixtureDirectory, urlPath.slice("/fixture/".length));
    return undefined;
  };

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
    response.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    if (request.method === "OPTIONS") return void response.writeHead(204).end();

    if (url.pathname === "/__ranges") {
      response.writeHead(200, { "Content-Type": "application/json" });
      return void response.end(JSON.stringify(rangeLog));
    }

    const target = resolveTarget(url.pathname);
    if (target === undefined) return void response.writeHead(404).end("not found");

    let info;
    try {
      info = await stat(target);
    } catch {
      return void response.writeHead(404).end("not found");
    }
    const type = MIME[path.extname(target).toLowerCase()] ?? "application/octet-stream";
    const range = request.headers.range;
    if (range !== undefined && type !== "text/html; charset=utf-8") {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match === null) return void response.writeHead(416).end();
      const start = match[1] === "" ? 0 : Number(match[1]);
      const end = match[2] === "" ? info.size - 1 : Math.min(Number(match[2]), info.size - 1);
      if (start > end || start >= info.size) {
        response.writeHead(416, { "Content-Range": `bytes */${info.size}` });
        return void response.end();
      }
      rangeLog.push({ path: url.pathname, start, end, bytes: end - start + 1 });
      response.writeHead(206, {
        "Content-Type": type,
        "Content-Range": `bytes ${start}-${end}/${info.size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": String(end - start + 1),
      });
      return void createReadStream(target, { start, end }).pipe(response);
    }
    response.writeHead(200, {
      "Content-Type": type,
      "Content-Length": String(info.size),
      "Accept-Ranges": "bytes",
    });
    if (request.method === "HEAD") return void response.end();
    createReadStream(target).pipe(response);
  });

  return {
    listen(port = 0) {
      return new Promise((resolve) => {
        server.listen(port, "127.0.0.1", () => resolve(server.address().port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
    rangeLog,
  };
}
