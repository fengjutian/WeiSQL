import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { WeiSQLError } from "./errors.js";
import { validateResourcePath } from "./resource-path.js";
import { validateByteRange } from "./resource-reader.js";
import type { ByteRange, ResourceMetadata, ResourceReader, ResourceReadOptions } from "./resource-reader.js";

export interface NodeFileResourceReaderOptions {
  rootDirectory: string;
  /** Maximum bytes accepted by read(); range reads are unaffected. */
  maxReadBytes?: number;
}

/** Node.js package reader with real-path containment and exact range reads. */
export class NodeFileResourceReader implements ResourceReader {
  private readonly rootDirectory: string;
  private readonly maxReadBytes: number;
  private rootRealPath: Promise<string> | undefined;
  private closed = false;

  constructor(options: NodeFileResourceReaderOptions) {
    if (!options.rootDirectory) throw new WeiSQLError("INVALID_ARGUMENT", "rootDirectory must be non-empty");
    if (options.maxReadBytes !== undefined && (!Number.isSafeInteger(options.maxReadBytes) || options.maxReadBytes < 0)) {
      throw new WeiSQLError("INVALID_ARGUMENT", "maxReadBytes must be a non-negative safe integer");
    }
    this.rootDirectory = path.resolve(options.rootDirectory);
    this.maxReadBytes = options.maxReadBytes ?? 64 * 1024 * 1024;
  }

  async read(resourcePath: string, options?: ResourceReadOptions): Promise<Uint8Array> {
    this.ensureOpen();
    this.ensureNotCancelled(options?.signal);
    const filename = await this.resolveResource(resourcePath);
    const info = await this.fileStat(filename, resourcePath);
    if (info.size > this.maxReadBytes) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Resource exceeds the configured full-read limit", { path: resourcePath, size: info.size, maxReadBytes: this.maxReadBytes });
    }
    return this.readFileRange(filename, resourcePath, { start: 0, end: info.size }, options?.signal);
  }

  async readRange(resourcePath: string, range: ByteRange, options?: ResourceReadOptions): Promise<Uint8Array> {
    this.ensureOpen();
    validateByteRange(range);
    this.ensureNotCancelled(options?.signal);
    if (range.start === range.end) return new Uint8Array();
    const filename = await this.resolveResource(resourcePath);
    return this.readFileRange(filename, resourcePath, range, options?.signal);
  }

  async stat(resourcePath: string, options?: ResourceReadOptions): Promise<ResourceMetadata> {
    this.ensureOpen();
    this.ensureNotCancelled(options?.signal);
    const filename = await this.resolveResource(resourcePath);
    const info = await this.fileStat(filename, resourcePath);
    return { size: info.size, lastModified: info.mtime.toISOString(), supportsRange: true };
  }

  async close(): Promise<void> { this.closed = true; }

  private async resolveResource(resourcePath: string): Promise<string> {
    validateResourcePath(resourcePath);
    const root = await (this.rootRealPath ??= realpath(this.rootDirectory).catch(cause => {
      this.rootRealPath = undefined;
      throw mapFileError(cause, "Package root is unavailable", this.rootDirectory);
    }));
    let resolved: string;
    try { resolved = await realpath(path.resolve(root, ...resourcePath.split("/"))); }
    catch (cause) { throw mapFileError(cause, "Resource could not be resolved", resourcePath); }
    const relative = path.relative(root, resolved);
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new WeiSQLError("PATH_INVALID", "Resource path escaped the configured package root", { path: resourcePath });
    }
    return resolved;
  }

  private async fileStat(filename: string, resourcePath: string) {
    try {
      const info = await stat(filename);
      if (!info.isFile()) throw new WeiSQLError("RESOURCE_NOT_FOUND", "Resource is not a regular file", { path: resourcePath });
      if (!Number.isSafeInteger(info.size)) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Resource size exceeds the safe integer range", { path: resourcePath });
      return info;
    } catch (cause) {
      if (cause instanceof WeiSQLError) throw cause;
      throw mapFileError(cause, "Resource metadata could not be read", resourcePath);
    }
  }

  private async readFileRange(filename: string, resourcePath: string, range: ByteRange, signal?: AbortSignal): Promise<Uint8Array> {
    let handle;
    try {
      handle = await open(filename, "r");
      const info = await handle.stat();
      if (!info.isFile()) throw new WeiSQLError("RESOURCE_NOT_FOUND", "Resource is not a regular file", { path: resourcePath });
      if (range.end > info.size) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Requested range exceeds the resource size", { path: resourcePath, range, size: info.size });
      const result = new Uint8Array(range.end - range.start);
      let read = 0;
      while (read < result.byteLength) {
        this.ensureNotCancelled(signal);
        const chunk = await handle.read(result, read, result.byteLength - read, range.start + read);
        if (chunk.bytesRead === 0) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Resource ended before the requested range was complete", { path: resourcePath, range, bytesRead: read });
        read += chunk.bytesRead;
      }
      return result;
    } catch (cause) {
      if (cause instanceof WeiSQLError) throw cause;
      throw mapFileError(cause, "Resource range could not be read", resourcePath);
    } finally {
      await handle?.close();
    }
  }

  private ensureOpen(): void {
    if (this.closed) throw new WeiSQLError("DATABASE_CLOSED", "ResourceReader has been closed");
  }

  private ensureNotCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Resource read was cancelled");
  }
}

function mapFileError(cause: unknown, message: string, resourcePath: string): WeiSQLError {
  const code = typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : undefined;
  if (code === "ENOENT" || code === "ENOTDIR") return new WeiSQLError({ code: "RESOURCE_NOT_FOUND", message, details: { path: resourcePath, systemCode: code }, cause });
  return new WeiSQLError({ code: "RESOURCE_READ_FAILED", message, details: { path: resourcePath }, cause });
}
