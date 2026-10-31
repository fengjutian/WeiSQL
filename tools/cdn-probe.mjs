#!/usr/bin/env node
/**
 * Header-level CDN/Range/CORS acceptance probe.
 *
 *   node tools/cdn-probe.mjs --manifest https://cdn.example.com/pkg/manifest.json
 *        [--resource data/documents.parquet] [--origin https://app.example.com] [--json]
 *
 * This checks what a browser needs but Node's `fetch` does not enforce:
 * `Access-Control-Allow-Origin`, exposed `Content-Range`/`Accept-Ranges`/`ETag`,
 * `206 Partial Content`, the exact `Content-Range`, and the returned byte count.
 * A real Chromium run is still the final word; this catches misconfiguration
 * before deploying the app.
 *
 * Exit codes: 0 all checks passed, 1 a required check failed, 2 usage error.
 */

const args = process.argv.slice(2);

function usage(message) {
  if (message) console.error(`error: ${message}`);
  console.error("usage: node tools/cdn-probe.mjs --manifest <url> [--resource <path>] [--origin <url>] [--json]");
  process.exit(2);
}

function readFlag(name) {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

if (args.includes("--help") || args.includes("-h")) usage();
const manifestUrl = readFlag("--manifest");
if (!manifestUrl) usage("--manifest is required");
let parsedManifestUrl;
try {
  parsedManifestUrl = new URL(manifestUrl);
} catch {
  usage("--manifest must be an absolute URL");
}
if (!/^https?:$/.test(parsedManifestUrl.protocol)) usage("--manifest must use http or https");

const origin = readFlag("--origin");
const json = args.includes("--json");
const forcedResource = readFlag("--resource");

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  if (!json) console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function warn(name, detail) {
  results.push({ name, ok: true, warning: true, detail });
  if (!json) console.log(`WARN  ${name}${detail ? ` — ${detail}` : ""}`);
}

function exposedHeaders(response) {
  return (response.headers.get("access-control-expose-headers") ?? "")
    .split(",")
    .map(value => value.trim().toLowerCase())
    .filter(Boolean);
}

function corsOrigin(response) {
  return response.headers.get("access-control-allow-origin");
}

function checkCors(label, response) {
  const allowed = corsOrigin(response);
  if (allowed === undefined) {
    check(`${label}: Access-Control-Allow-Origin`, false, "missing header");
    return;
  }
  if (allowed === "*") {
    check(`${label}: Access-Control-Allow-Origin`, true, "*");
    return;
  }
  if (origin === undefined) {
    warn(`${label}: Access-Control-Allow-Origin`, `${allowed} (pass --origin to verify the exact site origin)`);
    return;
  }
  check(`${label}: Access-Control-Allow-Origin`, allowed === origin || allowed === new URL(origin).origin, allowed);
}

function checkExposed(label, response, headers) {
  const exposed = exposedHeaders(response);
  if (exposed.includes("*")) {
    check(`${label}: exposed response headers`, true, "*");
    return;
  }
  const missing = headers.filter(header => !exposed.includes(header.toLowerCase()));
  check(`${label}: exposed response headers`, missing.length === 0, missing.length === 0 ? headers.join(", ") : `missing ${missing.join(", ")}`);
}

async function main() {
  const manifestResponse = await fetch(parsedManifestUrl, { headers: { accept: "application/json" } });
  check("manifest: HTTP 200", manifestResponse.ok, `${manifestResponse.status} ${manifestResponse.statusText}`);
  checkCors("manifest", manifestResponse);
  if (!manifestResponse.ok) {
    finish();
    return;
  }

  const manifest = await manifestResponse.json();
  const resources = [];
  for (const table of manifest.tables ?? []) if (table.file?.path) resources.push(table.file.path);
  for (const vector of manifest.vectorCollections ?? []) {
    if (vector.data?.path) resources.push(vector.data.path);
    if (vector.index?.file?.path) resources.push(vector.index.file.path);
  }
  for (const text of manifest.textIndexes ?? []) if (text.terms?.path) resources.push(text.terms.path);
  const resourcePath = forcedResource ?? resources[0];
  if (resourcePath === undefined) {
    check("resource: Manifest declares a readable resource", false, "no table, vector, index or text term file");
    finish();
    return;
  }
  if (forcedResource !== undefined && !resources.includes(forcedResource)) {
    warn("resource: declared by the Manifest", `${forcedResource} is not declared; the runtime would reject it`);
  }

  const resourceUrl = new URL(resourcePath, parsedManifestUrl);
  const rangeResponse = await fetch(resourceUrl, {
    headers: { range: "bytes=0-15", accept: "*/*" },
  });
  check("range: HTTP 206", rangeResponse.status === 206, `${rangeResponse.status} ${rangeResponse.statusText}`);
  checkCors("range", rangeResponse);
  const acceptRanges = rangeResponse.headers.get("accept-ranges");
  check("range: Accept-Ranges: bytes", acceptRanges?.toLowerCase() === "bytes", acceptRanges ?? "missing");
  const contentRange = rangeResponse.headers.get("content-range");
  check("range: Content-Range starts at 0-15", /^bytes 0-15\/\d+$/.test(contentRange ?? ""), contentRange ?? "missing");
  const contentLength = rangeResponse.headers.get("content-length");
  check("range: Content-Length is 16", contentLength === "16", contentLength ?? "missing");
  const body = new Uint8Array(await rangeResponse.arrayBuffer());
  check("range: body is 16 bytes", body.byteLength === 16, `${body.byteLength} bytes`);
  checkExposed("range", rangeResponse, ["Content-Range", "Accept-Ranges"]);
  const etag = rangeResponse.headers.get("etag");
  if (etag === null) {
    warn("range: ETag", "missing; cache revalidation will be weaker");
  } else {
    checkExposed("range", rangeResponse, ["ETag"]);
  }
  const cacheControl = rangeResponse.headers.get("cache-control");
  if (cacheControl === null) warn("range: Cache-Control", "missing; the CDN may not cache immutable versions");

  finish();
}

function finish() {
  const failed = results.filter(result => !result.ok);
  if (json) {
    console.log(JSON.stringify({
      manifest: parsedManifestUrl.href,
      origin: origin ?? null,
      passed: results.length - failed.length,
      failed: failed.length,
      results,
    }, null, 2));
  }
  if (failed.length > 0) process.exitCode = 1;
}

await main();
