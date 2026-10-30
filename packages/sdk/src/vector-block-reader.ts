import { WeiSQLError } from "./errors.js";
import type { ResourceReader } from "./resource-reader.js";
import { validateVectorBytes } from "./vector-size.js";
import type { VectorBlock } from "./vector-core-types.js";

export interface VectorFileDescriptor {
  path: string;
  count: number;
  dimension: number;
  bytes: number;
}

/** Reads and explicitly decodes little-endian, row-major Float32 vector blocks. */
export class VectorBlockReader {
  readonly descriptor: Readonly<VectorFileDescriptor>;

  constructor(private readonly reader: ResourceReader, descriptor: Readonly<VectorFileDescriptor>) {
    try { validateVectorBytes(descriptor); }
    catch (cause) {
      throw new WeiSQLError("INVALID_ARGUMENT", "Invalid vector file descriptor", { path: descriptor.path, cause: String(cause) });
    }
    this.descriptor = { ...descriptor };
  }

  async readBlock(startRow: number, requestedCount: number, options?: { signal?: AbortSignal }): Promise<VectorBlock> {
    const { count, dimension, path } = this.descriptor;
    if (!Number.isSafeInteger(startRow) || !Number.isSafeInteger(requestedCount) || startRow < 0 || requestedCount <= 0 || startRow >= count) {
      throw new WeiSQLError("INVALID_ARGUMENT", "Invalid vector block range", { path, startRow, requestedCount, count });
    }
    if (options?.signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Vector block read was cancelled", { path });
    const actualCount = Math.min(requestedCount, count - startRow);
    const rowBytes = dimension * 4;
    const start = startRow * rowBytes;
    const end = (startRow + actualCount) * rowBytes;
    const bytes = await this.reader.readRange(path, { start, end }, signalOptions(options?.signal));
    const expected = actualCount * rowBytes;
    if (bytes.byteLength !== expected) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Vector block byte length mismatch", { path, expected, actual: bytes.byteLength });
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const values = new Float32Array(actualCount * dimension);
    for (let i = 0; i < values.length; i++) {
      const value = view.getFloat32(i * 4, true);
      if (!Number.isFinite(value)) {
        throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Vector data contains a non-finite Float32 value", { path, row: startRow + Math.floor(i / dimension), dimension: i % dimension });
      }
      values[i] = value;
    }
    return { startRow, count: actualCount, values };
  }
}

function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } | undefined {
  return signal ? { signal } : undefined;
}
