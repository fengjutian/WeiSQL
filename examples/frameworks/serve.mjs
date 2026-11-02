/**
 * Minimal static server with the one behaviour the docs depend on: HTTP Range.
 *
 * Vite's dev/preview servers do not guarantee `206 Partial Content`, and the SDK
 * treats a `200` answer to a Range request as `CORS_OR_RANGE_UNSUPPORTED`. The
 * smoke test therefore serves `dist/` with this server, which also records every
 * range so the test can prove the package was read in slices.
 */
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".parquet": "application/octet-stream",
  ".f32": "application/octet-stream",
  ".offsets": "application/octet-stream",
  ".wasm": "application/wasm",
};

const resolveInside = (root, urlPath) => {
  const decoded = decodeURIComponent(urlPath);
  const target = path.resolve(root, `.${decoded}`);
  return target === root || target.startsWith(root + path.sep) ? target : undefined;
};

export async function serveDirectory(rootDirectory, { port = 0 } = {}) {
  const root = path.resolve(rootDirectory);
  const log = [];

  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Expose-Headers", "Content-Range, Content-Length, Accept-Ranges");
    response.setHeader("Access-Control-Allow-Headers", "Range");

    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__ranges") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(log));
      return;
    }

    let target = resolveInside(root, url.pathname === "/" ? "/index.html" : url.pathname);
    if (target === undefined) return void response.writeHead(403).end();
    const info = await stat(target).catch(() => undefined);
    if (info?.isDirectory()) target = path.join(target, "index.html");

    const file = await stat(target).catch(() => undefined);
    if (file === undefined || !file.isFile()) {
      log.push({ path: url.pathname, status: 404 });
      return void response.writeHead(404).end();
    }

    const type = MIME[path.extname(target)] ?? "application/octet-stream";
    const range = request.headers.range;
    const match = typeof range === "string" ? /^bytes=(\d+)-(\d*)$/.exec(range) : null;

    if (match === null) {
      log.push({ path: url.pathname, status: 200, bytes: file.size });
      response.writeHead(200, {
        "Content-Type": type,
        "Content-Length": String(file.size),
        "Accept-Ranges": "bytes",
      });
      if (request.method === "HEAD") return void response.end();
      return void createReadStream(target).pipe(response);
    }

    const start = Number(match[1]);
    const end = match[2] === "" ? file.size : Math.min(Number(match[2]) + 1, file.size);
    if (start >= end || start >= file.size) {
      log.push({ path: url.pathname, status: 416 });
      response.writeHead(416, { "Content-Range": `bytes */${file.size}` });
      return void response.end();
    }

    log.push({ path: url.pathname, status: 206, range: `${start}-${end - 1}` });
    response.writeHead(206, {
      "Content-Type": type,
      "Content-Length": String(end - start),
      "Content-Range": `bytes ${start}-${end - 1}/${file.size}`,
      "Accept-Ranges": "bytes",
    });
    if (request.method === "HEAD") return void response.end();
    createReadStream(target, { start, end: end - 1 }).pipe(response);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  return {
    port: server.address().port,
    log,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
