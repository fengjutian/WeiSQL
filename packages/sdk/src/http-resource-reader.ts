import { WeiSQLError } from "./errors.js";
import { normalizeResourcePath } from "./resource-path.js";
import { validateByteRange } from "./resource-reader.js";
import type { ByteRange, ResourceMetadata, ResourceReader, ResourceReadOptions } from "./resource-reader.js";

export interface HttpResourceReaderOptions {
  baseUrl: string;
  fetch?: typeof globalThis.fetch;
  credentials?: RequestCredentials;
}

/** Browser-safe HTTP resource reader with strict Range response validation. */
export class HttpResourceReader implements ResourceReader {
  private readonly baseUrl: URL;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly credentials: RequestCredentials;
  private closed = false;

  constructor(options: HttpResourceReaderOptions) {
    let baseUrl: URL;
    try { baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`); }
    catch (cause) { throw new WeiSQLError("INVALID_ARGUMENT", "baseUrl must be a valid absolute URL", { cause: String(cause) }); }
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new WeiSQLError("INVALID_ARGUMENT", "baseUrl must use HTTP or HTTPS");
    }
    if (baseUrl.username || baseUrl.password) {
      throw new WeiSQLError("INVALID_ARGUMENT", "baseUrl must not contain credentials");
    }
    this.baseUrl = baseUrl;
    // `globalThis.fetch` must keep its global receiver: browsers throw
    // "Illegal invocation" when fetch is called as a bare function.
    const fetcher = options.fetch ?? globalThis.fetch;
    if (!fetcher) throw new WeiSQLError("INVALID_ARGUMENT", "No fetch implementation is available");
    this.fetcher = fetcher.bind(globalThis);
    this.credentials = options.credentials ?? "same-origin";
  }

  async read(path: string, options?: ResourceReadOptions): Promise<Uint8Array> {
    this.ensureOpen();
    const response = await this.request(path, { method: "GET", ...signalInit(options?.signal) });
    this.ensureFinalUrl(path, response);
    if (!response.ok) this.throwHttp(path, response.status, "Resource request");
    return new Uint8Array(await response.arrayBuffer());
  }

  async readRange(path: string, range: ByteRange, options?: ResourceReadOptions): Promise<Uint8Array> {
    this.ensureOpen();
    validateByteRange(range);
    if (range.start === range.end) return new Uint8Array();
    const expectedLength = range.end - range.start;
    const response = await this.request(path, {
      method: "GET",
      headers: { Range: `bytes=${range.start}-${range.end - 1}` },
      ...signalInit(options?.signal),
    });
    this.ensureFinalUrl(path, response);
    if (response.status === 200) {
      throw new WeiSQLError("CORS_OR_RANGE_UNSUPPORTED", "Server ignored the Range request and returned HTTP 200", { path });
    }
    if (response.status === 416) {
      throw new WeiSQLError("INVALID_RANGE_RESPONSE", "Requested byte range is not satisfiable", { path, range });
    }
    if (response.status !== 206) this.throwHttp(path, response.status, "Range request");

    const contentRange = parseContentRange(response.headers.get("Content-Range"), path);
    if (contentRange.start !== range.start || contentRange.endInclusive !== range.end - 1) {
      throw new WeiSQLError("INVALID_RANGE_RESPONSE", "Server returned a different byte range than requested", { path, requested: range, received: contentRange });
    }
    if (contentRange.total !== undefined && contentRange.endInclusive >= contentRange.total) {
      throw new WeiSQLError("INVALID_RANGE_RESPONSE", "Content-Range exceeds the declared resource size", { path, received: contentRange });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== expectedLength) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", `Expected ${expectedLength} range bytes, received ${bytes.byteLength}`, { path, expected: expectedLength, actual: bytes.byteLength });
    }
    return bytes;
  }

  async stat(path: string, options?: ResourceReadOptions): Promise<ResourceMetadata> {
    this.ensureOpen();
    const response = await this.request(path, { method: "HEAD", ...signalInit(options?.signal) });
    this.ensureFinalUrl(path, response);
    if (!response.ok) this.throwHttp(path, response.status, "Resource metadata request");
    const rawLength = response.headers.get("Content-Length");
    let size: number | undefined;
    if (rawLength !== null) {
      if (!/^\d+$/.test(rawLength)) throw new WeiSQLError("RESOURCE_READ_FAILED", "Invalid Content-Length header", { path, contentLength: rawLength });
      size = Number(rawLength);
      if (!Number.isSafeInteger(size)) throw new WeiSQLError("RESOURCE_READ_FAILED", "Content-Length exceeds the safe integer range", { path, contentLength: rawLength });
    }
    const metadata: ResourceMetadata = {};
    if (size !== undefined) metadata.size = size;
    const etag = response.headers.get("ETag");
    if (etag !== null) metadata.etag = etag;
    const lastModified = response.headers.get("Last-Modified");
    if (lastModified !== null) metadata.lastModified = lastModified;
    if (response.headers.get("Accept-Ranges")?.toLowerCase() === "bytes") metadata.supportsRange = true;
    return metadata;
  }

  async close(): Promise<void> { this.closed = true; }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const url = this.resolveUrl(path);
    try { return await this.fetcher(url, { ...init, credentials: this.credentials }); }
    catch (cause) {
      if (isAbort(cause, init.signal)) throw new WeiSQLError("QUERY_CANCELLED", "Resource request was cancelled", { path });
      throw new WeiSQLError("RESOURCE_READ_FAILED", "Network request failed", { path, cause: String(cause) });
    }
  }

  private resolveUrl(path: string): URL {
    const normalized = normalizeResourcePath(path);
    const url = new URL(normalized, this.baseUrl);
    if (url.origin !== this.baseUrl.origin || !url.pathname.startsWith(this.baseUrl.pathname)) {
      throw new WeiSQLError("PATH_INVALID", "Resource URL escaped the configured package root", { path });
    }
    return url;
  }

  private ensureFinalUrl(path: string, response: Response): void {
    if (!response.url) return;
    const final = new URL(response.url);
    if (final.origin !== this.baseUrl.origin || !final.pathname.startsWith(this.baseUrl.pathname)) {
      throw new WeiSQLError("PATH_INVALID", "Resource redirect escaped the configured package root", { path });
    }
  }

  private throwHttp(path: string, status: number, operation: string): never {
    if (status === 404) throw new WeiSQLError("RESOURCE_NOT_FOUND", `${operation} failed with HTTP 404`, { path, status });
    throw new WeiSQLError("RESOURCE_READ_FAILED", `${operation} failed with HTTP ${status}`, { path, status });
  }

  private ensureOpen(): void {
    if (this.closed) throw new WeiSQLError("DATABASE_CLOSED", "ResourceReader has been closed");
  }
}

function signalInit(signal: AbortSignal | undefined): RequestInit {
  return signal ? { signal } : {};
}

function isAbort(cause: unknown, signal: AbortSignal | null | undefined): boolean {
  return signal?.aborted === true || (cause instanceof Error && cause.name === "AbortError");
}

function parseContentRange(value: string | null, path: string): { start: number; endInclusive: number; total?: number } {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+|\*)$/);
  if (!match) throw new WeiSQLError("INVALID_RANGE_RESPONSE", "Missing or invalid Content-Range header", { path, contentRange: value });
  const start = Number(match[1]);
  const endInclusive = Number(match[2]);
  const total = match[3] === "*" ? undefined : Number(match[3]);
  if (![start, endInclusive, ...(total === undefined ? [] : [total])].every(Number.isSafeInteger) || endInclusive < start) {
    throw new WeiSQLError("INVALID_RANGE_RESPONSE", "Content-Range contains invalid integers", { path, contentRange: value });
  }
  return total === undefined ? { start, endInclusive } : { start, endInclusive, total };
}
