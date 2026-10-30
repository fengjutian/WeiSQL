import { WeiSQLError } from "./errors.js";
import { IndexedIdMapReader } from "./indexed-id-map-reader.js";
import type { ResourceReader } from "./resource-reader.js";
import { bm25Score, tokenize } from "./text-search.js";
import type { Bm25TermStat } from "./text-search.js";
import type { TextIndexDescriptor } from "./types.js";

export interface TextSearchOptions {
  topK: number;
  signal?: AbortSignal;
}

export interface TextHit {
  row: number;
  id: string | number;
  /** BM25 relevance: **higher is better**, unlike vector distance. */
  score: number;
  diagnostics?: { backend: string; elapsedMs?: number };
}

interface Posting {
  row: number;
  termFrequency: number;
}

interface TermEntry {
  term: string;
  documentFrequency: number;
  postings: Posting[];
}

const DEFAULT_TOP_K_LIMIT = 1_000;

/**
 * Reads a V1 full-text index and answers BM25 queries.
 *
 * Query cost: one binary search per query term (O(log termCount) range reads),
 * one full read of `docLengths` (4 bytes per document), and one ID lookup for the
 * final candidates. The document lengths file is read whole because BM25 needs
 * `dl` for every candidate; at 1M documents that is 4 MB per query, which is a
 * documented V1 cost rather than a hidden one.
 */
export class TextIndexReader {
  private closed = false;
  constructor(private readonly reader: ResourceReader, readonly descriptor: Readonly<TextIndexDescriptor>) {
    if (!Number.isSafeInteger(descriptor.documentCount) || descriptor.documentCount < 1) {
      throw new WeiSQLError("INVALID_ARGUMENT", "Text index descriptor has an invalid documentCount", { documentCount: descriptor.documentCount });
    }
    if (!Number.isSafeInteger(descriptor.termCount) || descriptor.termCount < 1) {
      throw new WeiSQLError("INVALID_ARGUMENT", "Text index descriptor has an invalid termCount", { termCount: descriptor.termCount });
    }
    if (!(descriptor.averageDocumentLength > 0) || !Number.isFinite(descriptor.averageDocumentLength)) {
      throw new WeiSQLError("INVALID_ARGUMENT", "Text index descriptor has an invalid averageDocumentLength");
    }
  }

  async search(query: string, options: TextSearchOptions): Promise<readonly TextHit[]> {
    this.ensureOpen();
    const topK = options.topK ?? 10;
    if (!Number.isSafeInteger(topK) || topK <= 0 || topK > DEFAULT_TOP_K_LIMIT) {
      throw new WeiSQLError("INVALID_ARGUMENT", "topK must be a positive integer within the limit", { topK, limit: DEFAULT_TOP_K_LIMIT });
    }
    if (options.signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Text search was cancelled before execution");
    const started = typeof performance === "undefined" ? 0 : performance.now();

    const terms = [...new Set(tokenize(query))];
    if (terms.length === 0) return [];

    const offsets = await this.readTermOffsets(options.signal);
    const byRow = new Map<number, Bm25TermStat[]>();

    for (const term of terms) {
      if (options.signal?.aborted) throw new WeiSQLError("QUERY_CANCELLED", "Text search was cancelled");
      const entry = await this.lookupTerm(term, offsets, options.signal);
      if (entry === undefined) continue;
      for (const posting of entry.postings) {
        const list = byRow.get(posting.row);
        const stat: Bm25TermStat = { termFrequency: posting.termFrequency, documentFrequency: entry.documentFrequency };
        if (list === undefined) byRow.set(posting.row, [stat]);
        else list.push(stat);
      }
    }
    if (byRow.size === 0) return [];

    const lengths = await this.readDocLengths(options.signal);
    const scored: { row: number; score: number }[] = [];
    for (const [row, stats] of byRow) {
      const documentLength = lengths[row];
      if (documentLength === undefined) {
        throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Text index references a row beyond docLengths", { row, documentCount: this.descriptor.documentCount });
      }
      const score = bm25Score({
        documentCount: this.descriptor.documentCount,
        documentLength,
        averageDocumentLength: this.descriptor.averageDocumentLength,
        ...(this.descriptor.k1 === undefined ? {} : { k1: this.descriptor.k1 }),
        ...(this.descriptor.b === undefined ? {} : { b: this.descriptor.b }),
        terms: stats,
      });
      if (score > 0) scored.push({ row, score });
    }
    // Higher score first; ties by ascending row for stable, reproducible order.
    scored.sort((left, right) => right.score - left.score || left.row - right.row);
    const best = scored.slice(0, topK);

    const idMap = new IndexedIdMapReader(this.reader, {
      dataPath: this.descriptor.idMap.data.path,
      offsetsPath: this.descriptor.idMap.offsets.path,
      count: this.descriptor.idMap.count,
      dataBytes: this.descriptor.idMap.data.bytes,
      offsetsBytes: this.descriptor.idMap.offsets.bytes,
    });
    let ids: readonly (string | number)[];
    try {
      ids = await idMap.getIdsByRows(best.map(entry => entry.row), options.signal === undefined ? undefined : { signal: options.signal });
    } finally {
      await idMap.close();
    }
    const elapsedMs = typeof performance === "undefined" ? undefined : performance.now() - started;
    return best.map((entry, position) => ({
      row: entry.row,
      id: ids[position]!,
      score: entry.score,
      diagnostics: { backend: "text-bm25", ...(elapsedMs === undefined ? {} : { elapsedMs }) },
    }));
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private ensureOpen(): void {
    if (this.closed) throw new WeiSQLError("DATABASE_CLOSED", "Text index reader has been closed");
  }

  private async readTermOffsets(signal: AbortSignal | undefined): Promise<Float64Array> {
    const bytes = await this.reader.readRange(
      this.descriptor.termOffsets.path,
      { start: 0, end: this.descriptor.termCount * 8 },
      signal === undefined ? undefined : { signal },
    );
    if (bytes.byteLength !== this.descriptor.termCount * 8) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Term offset file length mismatch", { expected: this.descriptor.termCount * 8, actual: bytes.byteLength });
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const offsets = new Float64Array(this.descriptor.termCount);
    for (let index = 0; index < offsets.length; index++) {
      const value = view.getBigUint64(index * 8, true);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Term offset exceeds the safe integer range", { index });
      offsets[index] = Number(value);
    }
    return offsets;
  }

  private async readDocLengths(signal: AbortSignal | undefined): Promise<Uint32Array> {
    const expected = this.descriptor.documentCount * 4;
    const bytes = await this.reader.readRange(this.descriptor.docLengths.path, { start: 0, end: expected }, signal === undefined ? undefined : { signal });
    if (bytes.byteLength !== expected) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Document length file length mismatch", { expected, actual: bytes.byteLength });
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const lengths = new Uint32Array(this.descriptor.documentCount);
    for (let index = 0; index < lengths.length; index++) lengths[index] = view.getUint32(index * 4, true);
    return lengths;
  }

  /**
   * Binary search over the sorted term file.
   *
   * Ordering is the generator's plain JavaScript string comparison (UTF-16 code
   * units, matching `Array.prototype.sort`), not raw UTF-8 byte order; the two
   * differ for astral characters, so both sides must use the same rule.
   */
  private async lookupTerm(term: string, offsets: Float64Array, signal: AbortSignal | undefined): Promise<TermEntry | undefined> {
    let low = 0;
    let high = this.descriptor.termCount - 1;
    while (low <= high) {
      const middle = (low + high) >>> 1;
      const entry = await this.readTermAt(middle, offsets, signal);
      if (entry.term === term) return entry;
      if (entry.term < term) low = middle + 1;
      else high = middle - 1;
    }
    return undefined;
  }

  private async readTermAt(index: number, offsets: Float64Array, signal: AbortSignal | undefined): Promise<TermEntry> {
    const start = offsets[index]!;
    const next = index + 1 < this.descriptor.termCount ? offsets[index + 1]! : this.descriptor.data.bytes;
    if (next <= start) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Term offsets are not strictly increasing", { index, start, next });
    const bytes = await this.reader.readRange(this.descriptor.data.path, { start, end: next }, signal === undefined ? undefined : { signal });
    if (bytes.byteLength !== next - start) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Term record byte length mismatch", { index, expected: next - start, actual: bytes.byteLength });
    }
    let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.endsWith("\n")) text = text.slice(0, -1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Term record is not valid JSON", { index, cause: String(cause) });
    }
    if (typeof parsed !== "object" || parsed === null) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Term record must be an object", { index });
    const record = parsed as { term?: unknown; df?: unknown; postings?: unknown };
    if (typeof record.term !== "string") throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Term record is missing 'term'", { index });
    if (!Number.isSafeInteger(record.df) || (record.df as number) < 1) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Term record has an invalid document frequency", { index });
    if (!Array.isArray(record.postings) || record.postings.length !== record.df) {
      throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Term postings length must equal its document frequency", { index });
    }
    const postings: Posting[] = [];
    let previous = -1;
    for (const item of record.postings as unknown[]) {
      if (!Array.isArray(item) || item.length !== 2) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Posting must be [row, termFrequency]", { index, term: record.term });
      const [row, termFrequency] = item as unknown[];
      if (!Number.isSafeInteger(row) || (row as number) < 0 || (row as number) >= this.descriptor.documentCount) {
        throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Posting row is out of range", { index, term: record.term });
      }
      if ((row as number) <= previous) throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Posting rows must be strictly increasing", { index, term: record.term });
      previous = row as number;
      if (!Number.isSafeInteger(termFrequency) || (termFrequency as number) < 1) {
        throw new WeiSQLError("RESOURCE_INTEGRITY_FAILED", "Posting term frequency must be a positive integer", { index, term: record.term });
      }
      postings.push({ row: row as number, termFrequency: termFrequency as number });
    }
    return { term: record.term, documentFrequency: record.df as number, postings };
  }
}
