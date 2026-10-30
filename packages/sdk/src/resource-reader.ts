import type { WeiSQLManifest } from "./types.js";
import { WeiSQLError } from "./errors.js";

export interface ResourceMetadata {
  size?: number;
  etag?: string;
  lastModified?: string;
  supportsRange?: boolean;
}

/** A half-open byte range: start is inclusive and end is exclusive. */
export interface ByteRange {
  start: number;
  end: number;
}

export interface ResourceReadOptions { signal?: AbortSignal }

/** Runtime-neutral resource access used by Runtime and engine adapters. */
export interface ResourceReader {
  read(path: string, options?: ResourceReadOptions): Promise<Uint8Array>;
  readRange(path: string, range: ByteRange, options?: ResourceReadOptions): Promise<Uint8Array>;
  stat(path: string, options?: ResourceReadOptions): Promise<ResourceMetadata>;
  close(): Promise<void>;
}

export interface AdapterOpenOptions {
  reader: ResourceReader;
  manifest: Readonly<WeiSQLManifest>;
  signal?: AbortSignal;
}

export function validateByteRange(range: ByteRange): void {
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < 0 || range.end < range.start) {
    throw new WeiSQLError("INVALID_ARGUMENT", "Byte range must use non-negative safe integers with end >= start", { range });
  }
}
