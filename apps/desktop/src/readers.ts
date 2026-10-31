import { validateByteRange, WeiSQLError } from "@weisql/sdk";
import type { ByteRange, ContainerByteSource, ResourceMetadata, ResourceReader } from "@weisql/sdk";

import type { TauriBackend } from "./backend.js";

/** Guards against manifests that try to escape the directory the user opened. */
export function assertResourcePath(path: string): void {
  if (path.length === 0) {
    throw new WeiSQLError("INVALID_ARGUMENT", "Resource path is empty");
  }
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    throw new WeiSQLError("INVALID_ARGUMENT", `Unsafe resource path '${path}'`);
  }
  for (const segment of path.split("/")) {
    if (segment === "" || segment === "." || segment === "..") {
      throw new WeiSQLError("INVALID_ARGUMENT", `Unsafe resource path '${path}'`);
    }
  }
}

/** `root/manifest.json` while keeping Windows separators out of the manifest. */
export function joinPath(root: string, relative: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${relative}`;
}

/**
 * Reads a package directory through native range reads. `stat` comes from the
 * filesystem so the SDK never guesses a size, and ranges are checked again in
 * Rust before any bytes are returned.
 */
export class BackendDirectoryReader implements ResourceReader {
  constructor(
    private readonly backend: TauriBackend,
    private readonly root: string,
  ) {}

  async read(path: string, options?: { signal?: AbortSignal }): Promise<Uint8Array> {
    options?.signal?.throwIfAborted();
    const metadata = await this.stat(path, options);
    if (metadata.size === undefined) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Resource size is unknown", { path });
    }
    return this.readRange(path, { start: 0, end: metadata.size }, options);
  }

  async readRange(path: string, range: ByteRange, options?: { signal?: AbortSignal }): Promise<Uint8Array> {
    assertResourcePath(path);
    validateByteRange(range);
    options?.signal?.throwIfAborted();
    return this.backend.readRange(joinPath(this.root, path), range.start, range.end);
  }

  async stat(path: string, options?: { signal?: AbortSignal }): Promise<ResourceMetadata> {
    assertResourcePath(path);
    options?.signal?.throwIfAborted();
    const stat = await this.backend.stat(joinPath(this.root, path));
    if (stat.isDirectory) {
      throw new WeiSQLError("RESOURCE_NOT_FOUND", "Resource is a directory", { path });
    }
    return { size: stat.size, supportsRange: true, ...(stat.lastModified === undefined ? {} : { lastModified: new Date(stat.lastModified).toISOString() }) };
  }

  async close(): Promise<void> {
    // Nothing to release: each read opens and closes its own file handle.
  }
}

/** Range source over a `.wsql` container, so the file is never fully loaded. */
export class BackendContainerSource implements ContainerByteSource {
  private sizeValue: number | undefined;

  constructor(
    private readonly backend: TauriBackend,
    private readonly path: string,
  ) {}

  async size(): Promise<number> {
    if (this.sizeValue === undefined) {
      const stat = await this.backend.stat(this.path);
      if (stat.isDirectory) throw new WeiSQLError("INVALID_ARGUMENT", "A .wsql package must be a file", { path: this.path });
      this.sizeValue = stat.size;
    }
    return this.sizeValue;
  }

  async readRange(range: ByteRange): Promise<Uint8Array> {
    validateByteRange(range);
    return this.backend.readRange(this.path, range.start, range.end);
  }
}

/**
 * Reads the bundled example package over HTTP. It works in the plain browser
 * preview and inside Tauri (the assets ship with the app), which keeps the demo
 * independent of the local filesystem.
 */
export class SampleReader implements ResourceReader {
  private readonly base = new URL("sample/", document.baseURI);
  private readonly cache = new Map<string, Uint8Array>();

  async read(path: string): Promise<Uint8Array> {
    assertResourcePath(path);
    const cached = this.cache.get(path);
    if (cached !== undefined) return cached;
    const url = new URL(path, this.base);
    const response = await fetch(url);
    if (!response.ok) {
      throw new WeiSQLError("RESOURCE_NOT_FOUND", `示例资源读取失败（HTTP ${response.status}）`, { path, url: url.href });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    this.cache.set(path, bytes);
    return bytes;
  }

  async readRange(path: string, range: ByteRange): Promise<Uint8Array> {
    validateByteRange(range);
    const bytes = await this.read(path);
    if (range.end > bytes.byteLength) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Range extends past the sample resource", { path, range, size: bytes.byteLength });
    }
    return bytes.slice(range.start, range.end);
  }

  async stat(path: string): Promise<ResourceMetadata> {
    const bytes = await this.read(path);
    return { size: bytes.byteLength, supportsRange: true };
  }

  async close(): Promise<void> {
    this.cache.clear();
  }
}

export interface ReaderStats {
  calls: number;
  bytes: number;
}

/** Records how many range requests a session issued, for the diagnostics panel. */
export class CountingReader implements ResourceReader {
  readonly stats: ReaderStats = { calls: 0, bytes: 0 };

  constructor(private readonly inner: ResourceReader) {}

  async read(path: string, options?: { signal?: AbortSignal }): Promise<Uint8Array> {
    const bytes = await this.inner.read(path, options);
    this.stats.calls += 1;
    this.stats.bytes += bytes.byteLength;
    return bytes;
  }

  async readRange(path: string, range: ByteRange, options?: { signal?: AbortSignal }): Promise<Uint8Array> {
    const bytes = await this.inner.readRange(path, range, options);
    this.stats.calls += 1;
    this.stats.bytes += bytes.byteLength;
    return bytes;
  }

  async stat(path: string, options?: { signal?: AbortSignal }): Promise<ResourceMetadata> {
    return this.inner.stat(path, options);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}
