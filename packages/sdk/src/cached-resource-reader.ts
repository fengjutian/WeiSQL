import { WeiSQLError } from "./errors.js";
import type { ByteRange, ResourceMetadata, ResourceReader, ResourceReadOptions } from "./resource-reader.js";
import { validateByteRange } from "./resource-reader.js";
import type { CacheOptions } from "./types.js";

export interface CachedResourceReaderOptions extends CacheOptions {
  /** Underlying reader. The cache owns it and closes it on `close()`. */
  reader: ResourceReader;
}

export interface CacheStats {
  /** Requests served from the cache. */
  hits: number;
  /** Requests that had to read the underlying reader. */
  misses: number;
  /** Requests that joined an in-flight read instead of starting a new one. */
  coalesced: number;
  /** Ranges larger than `maxEntryBytes`, which never enter the cache. */
  bypasses: number;
  /** Entries removed to stay inside the byte budget. */
  evictions: number;
  entries: number;
  cachedBytes: number;
  /** Bytes actually read from the underlying reader. */
  bytesRead: number;
  /** Reads currently in flight. */
  inflight: number;
}

interface InflightRead {
  controller: AbortController;
  origin: Promise<Uint8Array>;
  waiters: number;
}

const DEFAULT_MAX_CACHE_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ENTRY_BYTES = 1024 * 1024;
const DEFAULT_MAX_CONCURRENT_READS = 8;

/**
 * Bounded LRU cache and request coalescer for `ResourceReader`.
 *
 * Why a decorator instead of logic inside each reader: the cache key must include
 * the publication identity, and every reader (HTTP, Node file, future `.wsql`)
 * needs the same eviction, coalescing and cancellation semantics.
 *
 * Cancellation ownership: each caller owns its own promise. An aborted caller is
 * rejected with `QUERY_CANCELLED`, but the shared underlying request is aborted
 * only when *every* remaining waiter has cancelled, so one impatient caller
 * cannot destroy another caller's read.
 *
 * Failures, short reads and oversized ranges are never cached; a failed read must
 * not poison later reads of the same range.
 */
export class CachedResourceReader implements ResourceReader {
  private readonly inner: ResourceReader;
  private readonly maxCacheBytes: number;
  private readonly maxEntryBytes: number;
  private readonly maxConcurrentReads: number;
  private publicationVersion: string;
  private readonly entries = new Map<string, Uint8Array>();
  private readonly inflight = new Map<string, InflightRead>();
  private cachedBytes = 0;
  private activeReads = 0;
  private readonly queue: (() => void)[] = [];
  private closed = false;
  private readonly counters = { hits: 0, misses: 0, coalesced: 0, bypasses: 0, evictions: 0, bytesRead: 0 };

  constructor(options: CachedResourceReaderOptions) {
    this.inner = options.reader;
    this.maxCacheBytes = positiveInteger(options.maxCacheBytes, DEFAULT_MAX_CACHE_BYTES, "maxCacheBytes");
    this.maxEntryBytes = positiveInteger(options.maxEntryBytes, DEFAULT_MAX_ENTRY_BYTES, "maxEntryBytes");
    this.maxConcurrentReads = positiveInteger(options.maxConcurrentReads, DEFAULT_MAX_CONCURRENT_READS, "maxConcurrentReads");
    this.publicationVersion = options.version ?? "unversioned";
  }

  /**
   * Isolates the cache from a previous release. Entries keyed by an older
   * publication are dropped instead of being reused for different bytes.
   */
  setPublicationVersion(version: string): void {
    if (version === this.publicationVersion) return;
    this.publicationVersion = version;
    this.entries.clear();
    this.cachedBytes = 0;
  }

  stats(): CacheStats {
    return {
      ...this.counters,
      entries: this.entries.size,
      cachedBytes: this.cachedBytes,
      inflight: this.inflight.size,
    };
  }

  async read(path: string, options?: ResourceReadOptions): Promise<Uint8Array> {
    this.ensureOpen();
    throwIfAborted(options?.signal);
    return this.readThrough(path, undefined, options?.signal);
  }

  async readRange(path: string, range: ByteRange, options?: ResourceReadOptions): Promise<Uint8Array> {
    this.ensureOpen();
    validateByteRange(range);
    const signal = options?.signal;
    throwIfAborted(signal);
    if (range.start === range.end) return new Uint8Array();

    const key = this.keyFor(path, range);
    const cached = this.entries.get(key);
    if (cached !== undefined) {
      this.counters.hits++;
      this.touch(key, cached);
      return Uint8Array.from(cached);
    }
    const length = range.end - range.start;
    if (length > this.maxEntryBytes) {
      this.counters.bypasses++;
      return this.readThrough(path, range, signal);
    }
    this.counters.misses++;

    const existing = this.inflight.get(key);
    if (existing !== undefined) {
      this.counters.coalesced++;
      return this.join(existing, signal);
    }

    const entry: InflightRead = { controller: new AbortController(), origin: Promise.resolve(new Uint8Array()), waiters: 0 };
    entry.origin = this.readThrough(path, range, entry.controller.signal)
      .then(bytes => {
        // Only complete responses are cacheable; a short read is an integrity
        // failure and must not be replayed from the cache.
        if (bytes.byteLength === length) this.store(key, bytes);
        return bytes;
      })
      .finally(() => { this.inflight.delete(key); });
    entry.origin.catch(() => undefined);
    this.inflight.set(key, entry);
    return this.join(entry, signal);
  }

  async stat(path: string, options?: ResourceReadOptions): Promise<ResourceMetadata> {
    this.ensureOpen();
    return this.inner.stat(path, options);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const entry of this.inflight.values()) entry.controller.abort();
    this.inflight.clear();
    this.entries.clear();
    this.cachedBytes = 0;
    this.queue.length = 0;
    await this.inner.close();
  }

  private join(entry: InflightRead, signal: AbortSignal | undefined): Promise<Uint8Array> {
    entry.waiters++;
    return new Promise<Uint8Array>((resolve, reject) => {
      let settled = false;
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        entry.waiters--;
        if (entry.waiters === 0) {
          entry.controller.abort();
          for (const [key, value] of this.inflight) if (value === entry) this.inflight.delete(key);
        }
        reject(new WeiSQLError("QUERY_CANCELLED", "Cached read was cancelled before it completed"));
      };
      if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
      entry.origin.then(
        bytes => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          resolve(bytes);
        },
        error => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  private async readThrough(path: string, range: ByteRange | undefined, signal: AbortSignal | undefined): Promise<Uint8Array> {
    const release = await this.acquire();
    try {
      throwIfAborted(signal);
      const bytes = range === undefined
        ? await this.inner.read(path, signal === undefined ? undefined : { signal })
        : await this.inner.readRange(path, range, signal === undefined ? undefined : { signal });
      this.counters.bytesRead += bytes.byteLength;
      return bytes;
    } finally {
      release();
    }
  }

  private async acquire(): Promise<() => void> {
    if (this.activeReads < this.maxConcurrentReads) {
      this.activeReads++;
      return () => this.release();
    }
    await new Promise<void>(resolve => this.queue.push(resolve));
    this.activeReads++;
    return () => this.release();
  }

  private release(): void {
    this.activeReads--;
    const next = this.queue.shift();
    if (next !== undefined) next();
  }

  private store(key: string, bytes: Uint8Array): void {
    if (bytes.byteLength > this.maxCacheBytes) return;
    // Keep a private copy: the caller that triggered the read still owns the
    // array it received, and mutating it must not poison later cache hits.
    const entry = Uint8Array.from(bytes);
    const previous = this.entries.get(key);
    if (previous !== undefined) this.cachedBytes -= previous.byteLength;
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.cachedBytes += entry.byteLength;
    while (this.cachedBytes > this.maxCacheBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      const evicted = this.entries.get(oldest.value)!;
      this.entries.delete(oldest.value);
      this.cachedBytes -= evicted.byteLength;
      this.counters.evictions++;
    }
  }

  private touch(key: string, bytes: Uint8Array): void {
    this.entries.delete(key);
    this.entries.set(key, bytes);
  }

  private keyFor(path: string, range: ByteRange): string {
    return `${this.publicationVersion}\u0000${path}\u0000${range.start}\u0000${range.end}`;
  }

  private ensureOpen(): void {
    if (this.closed) throw new WeiSQLError("DATABASE_CLOSED", "CachedResourceReader has been closed");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Resource read was cancelled");
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) throw new WeiSQLError("INVALID_ARGUMENT", `${name} must be a positive safe integer`, { [name]: value });
  return value;
}
