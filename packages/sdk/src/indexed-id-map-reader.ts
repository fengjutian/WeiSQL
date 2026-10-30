import { WeiSQLError } from "./errors.js";
import type { ResourceReader } from "./resource-reader.js";
import type { IdMapReader } from "./vector-core-types.js";

const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

export interface IndexedIdMapDescriptor { dataPath: string; offsetsPath: string; count: number; dataBytes: number; offsetsBytes: number }
export interface IndexedIdMapReaderOptions { maxBatchRows?: number }

export function decodeUint64LE(bytes: Uint8Array, offset: number): bigint {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 8 > bytes.byteLength) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Offset index is truncated", { offset, byteLength: bytes.byteLength });
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getBigUint64(offset, true);
}

export function parseIdMapLine(bytes: Uint8Array): { row: number; id: string | number } {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (cause) { throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Invalid ID map JSON or UTF-8", { cause: String(cause) }); }
  if (!isRecord(value) || !Number.isSafeInteger(value.row) || (value.row as number) < 0) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Invalid ID map row");
  const id = value.id;
  if ((typeof id !== "string" || id.length === 0) && (typeof id !== "number" || !Number.isSafeInteger(id))) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Invalid ID map business ID", { row: value.row });
  return { row: value.row as number, id };
}

/** Random-access JSONL reader backed by little-endian UInt64 start offsets. */
export class IndexedIdMapReader implements IdMapReader {
  private closed = false;
  readonly descriptor: Readonly<IndexedIdMapDescriptor>;
  private readonly maxBatchRows: number;
  constructor(private readonly reader: ResourceReader, descriptor: Readonly<IndexedIdMapDescriptor>, options: IndexedIdMapReaderOptions = {}) {
    if (!Number.isSafeInteger(descriptor.count) || descriptor.count <= 0 || !Number.isSafeInteger(descriptor.dataBytes) || descriptor.dataBytes <= 0 || BigInt(descriptor.count) * 8n > MAX_SAFE_BIGINT || descriptor.offsetsBytes !== descriptor.count * 8) throw new WeiSQLError("INVALID_ARGUMENT", "Invalid indexed ID map descriptor", { descriptor });
    this.maxBatchRows = options.maxBatchRows ?? 256;
    if (!Number.isSafeInteger(this.maxBatchRows) || this.maxBatchRows <= 0) throw new WeiSQLError("INVALID_ARGUMENT", "maxBatchRows must be a positive safe integer", { maxBatchRows: this.maxBatchRows });
    this.descriptor = { ...descriptor };
  }
  async getIds(startRow: number, requestedCount: number, options?: { signal?: AbortSignal }): Promise<readonly (string | number)[]> {
    this.ensureOpen();
    const { count, dataBytes, dataPath, offsetsPath } = this.descriptor;
    if (!Number.isSafeInteger(startRow) || !Number.isSafeInteger(requestedCount) || startRow < 0 || requestedCount < 0 || startRow > count || requestedCount > count - startRow) throw new WeiSQLError("INVALID_ARGUMENT", "Invalid ID map range", { startRow, requestedCount, count });
    if (requestedCount === 0) return [];
    if (requestedCount > this.maxBatchRows) throw new WeiSQLError("INVALID_ARGUMENT", "ID map batch exceeds maxBatchRows", { requestedCount, maxBatchRows: this.maxBatchRows });
    if (options?.signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "ID map read was cancelled");
    const actualCount = Math.min(requestedCount, count - startRow);
    const endRow = startRow + actualCount;
    const entryCount = actualCount + (endRow < count ? 1 : 0);
    const indexBytes = await this.reader.readRange(offsetsPath, { start: startRow * 8, end: (startRow + entryCount) * 8 }, signalOptions(options?.signal));
    if (indexBytes.byteLength !== entryCount * 8) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID offset index byte length mismatch", { expected: entryCount * 8, actual: indexBytes.byteLength });
    const starts: number[] = [];
    for (let i = 0; i < entryCount; i++) starts.push(safeOffset(decodeUint64LE(indexBytes, i * 8), dataBytes));
    if (startRow === 0 && starts[0] !== 0) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "The first ID map offset must be zero");
    for (let i = 1; i < starts.length; i++) if (starts[i]! <= starts[i - 1]!) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID map offsets must be strictly increasing", { row: startRow + i });
    const dataStart = starts[0]!;
    const dataEnd = endRow < count ? starts[starts.length - 1]! : dataBytes;
    if (dataEnd <= dataStart) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID map data range is empty or reversed", { dataStart, dataEnd });
    const data = await this.reader.readRange(dataPath, { start: dataStart, end: dataEnd }, signalOptions(options?.signal));
    if (data.byteLength !== dataEnd - dataStart) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID map data byte length mismatch", { expected: dataEnd - dataStart, actual: data.byteLength });
    const ids: (string | number)[] = [];
    for (let i = 0; i < actualCount; i++) {
      const recordStart = starts[i]! - dataStart;
      let recordEnd = (i + 1 < starts.length ? starts[i + 1]! : dataEnd) - dataStart;
      if (recordEnd > recordStart && data[recordEnd - 1] === 0x0a) recordEnd--;
      if (recordEnd > recordStart && data[recordEnd - 1] === 0x0d) recordEnd--;
      if (recordEnd <= recordStart) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID map contains an empty record", { row: startRow + i });
      const record = parseIdMapLine(data.subarray(recordStart, recordEnd));
      const expectedRow = startRow + i;
      if (record.row !== expectedRow) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID map row does not match its offset index", { expected: expectedRow, actual: record.row });
      ids.push(record.id);
    }
    return ids;
  }
  async getIdsByRows(rows: readonly number[], options?: { signal?: AbortSignal }): Promise<readonly (string | number)[]> {
    this.ensureOpen();
    if (rows.length === 0) return [];
    for (const row of rows) if (!Number.isSafeInteger(row) || row < 0 || row >= this.descriptor.count) throw new WeiSQLError("INVALID_ARGUMENT", "ID row is out of bounds", { row, count: this.descriptor.count });
    const unique = [...new Set(rows)].sort((a, b) => a - b);
    const byRow = new Map<number, string | number>();
    let index = 0;
    while (index < unique.length) {
      if (options?.signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "ID map read was cancelled");
      const start = unique[index]!;
      let end = index + 1;
      while (end < unique.length && unique[end] === unique[end - 1]! + 1 && end - index < this.maxBatchRows) end++;
      const ids = await this.getIds(start, end - index, options);
      for (let i = index; i < end; i++) byRow.set(unique[i]!, ids[i - index]!);
      index = end;
    }
    return rows.map(row => byRow.get(row)!);
  }
  async close(): Promise<void> { this.closed = true; }
  private ensureOpen(): void { if (this.closed) throw new WeiSQLError("DATABASE_CLOSED", "ID map reader has been closed"); }
}

function safeOffset(value: bigint, dataBytes: number): number {
  if (value > MAX_SAFE_BIGINT) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID map offset exceeds JavaScript's safe integer range", { offset: value.toString() });
  const offset = Number(value);
  if (offset > dataBytes) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "ID map offset exceeds the data file", { offset, dataBytes });
  return offset;
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } | undefined { return signal ? { signal } : undefined; }
