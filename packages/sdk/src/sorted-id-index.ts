import { WeiSQLError } from "./errors.js";
import type { ResourceReader } from "./resource-reader.js";
import type { VectorCollectionDescriptor } from "./types.js";

/**
 * Sorted `id → row` index, loaded into memory once per Runtime.
 *
 * An earlier design binary-searched the file record by record; that turned
 * 1,000 lookups into ~17,000 range requests and 5.4 s of latency. The whole file
 * is only slightly smaller than the ID Map it replaces, so one read plus an
 * in-memory binary search is both simpler and faster.
 */
export class SortedIdIndexReader {
  private ids: Array<string | number> | undefined;
  private rows: number[] | undefined;
  private loading: Promise<void> | undefined;
  private closed = false;

  constructor(
    private readonly reader: ResourceReader,
    private readonly descriptor: NonNullable<VectorCollectionDescriptor["idIndex"]>,
  ) {
    if (!Number.isSafeInteger(descriptor.count) || descriptor.count < 0) {
      throw new WeiSQLError("INVALID_ARGUMENT", "ID index has an invalid count", { count: descriptor.count });
    }
  }

  /** Loads and parses the index; safe to call repeatedly. */
  async load(signal?: AbortSignal): Promise<void> {
    if (this.ids !== undefined) return;
    if (this.loading !== undefined) return this.loading;
    this.loading = this.#load(signal).finally(() => { this.loading = undefined; });
    return this.loading;
  }

  async rowsOf(ids: readonly (string | number)[], signal?: AbortSignal): Promise<number[]> {
    this.ensureOpen();
    await this.load(signal);
    const found: number[] = [];
    for (const id of ids) {
      if (signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "ID index lookup was cancelled");
      const row = this.#search(id);
      if (row !== undefined) found.push(row);
    }
    return found;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.ids = undefined;
    this.rows = undefined;
  }

  async #load(signal: AbortSignal | undefined): Promise<void> {
    const bytes = await this.reader.read(this.descriptor.data.path, signal === undefined ? undefined : { signal });
    if (bytes.byteLength !== this.descriptor.data.bytes) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID index has the wrong length", { expected: this.descriptor.data.bytes, actual: bytes.byteLength });
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (cause) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID index is not valid UTF-8", { cause: String(cause) });
    }
    const lines = text.split("\n");
    const ids: Array<string | number> = [];
    const rows: number[] = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (line === "") continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch (cause) {
        throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID index record is not valid JSON", { index, cause: String(cause) });
      }
      const record = parsed as { id?: unknown; row?: unknown };
      if (this.descriptor.idType === "string" && typeof record.id === "string") ids.push(record.id);
      else if (this.descriptor.idType === "integer" && typeof record.id === "number" && Number.isSafeInteger(record.id)) ids.push(record.id);
      else throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID index mixes id types", { index });
      if (!Number.isSafeInteger(record.row) || (record.row as number) < 0 || (record.row as number) >= this.descriptor.count) {
        throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID index row is out of range", { index });
      }
      rows.push(record.row as number);
    }
    if (ids.length !== this.descriptor.count) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID index count does not match the Manifest", { expected: this.descriptor.count, actual: ids.length });
    }
    this.ids = ids;
    this.rows = rows;
  }

  #search(target: string | number): number | undefined {
    const ids = this.ids!;
    const rows = this.rows!;
    if (this.descriptor.idType === "string" && typeof target !== "string") return undefined;
    if (this.descriptor.idType === "integer" && (typeof target !== "number" || !Number.isSafeInteger(target))) return undefined;
    let low = 0;
    let high = ids.length - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const comparison = compareIds(ids[middle]!, target);
      if (comparison === 0) return rows[middle];
      if (comparison < 0) low = middle + 1;
      else high = middle - 1;
    }
    return undefined;
  }

  private ensureOpen(): void {
    if (this.closed) throw new WeiSQLError("DATABASE_CLOSED", "ID index reader has been closed");
  }
}

/**
 * Chooses between loading the index once and scanning the whole ID Map.
 * Loading wins when the index is not larger than the data it replaces.
 */
export function shouldUseIdIndex(
  index: NonNullable<VectorCollectionDescriptor["idIndex"]>,
  idMap: { data: { bytes: number }; offsets: { bytes: number } },
): boolean {
  return index.data.bytes + index.offsets.bytes <= idMap.data.bytes + idMap.offsets.bytes;
}

/** Ordering shared by the builder and the reader: numbers numerically, strings by code unit. */
export function compareIds(left: string | number, right: string | number): number {
  if (typeof left === "number" && typeof right === "number") return left < right ? -1 : left > right ? 1 : 0;
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}
