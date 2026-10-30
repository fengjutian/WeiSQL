/**
 * Text tokenization and BM25 scoring for the full-text index (REQ-306).
 *
 * These are pure functions with no I/O: the index format and Runtime wiring are
 * separate steps, so the scoring rules can be tested on their own. See
 * `docs/FULL_TEXT_SEARCH.md` for the format proposal and the V1 limits.
 */

const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export interface TokenizeOptions {
  /** Tokens shorter than this are dropped; defaults to 1. */
  minLength?: number;
}

/**
 * Splits text into search terms.
 *
 * V1 rules, all deliberate and documented:
 * - NFC normalisation, then lower-casing;
 * - non letter/number code points are separators;
 * - CJK characters become **single-character** tokens, because no segmenter is
 *   bundled and whole-run matching would make Chinese search useless;
 * - no stemming, no stop words.
 */
export function tokenize(text: string, options: TokenizeOptions = {}): string[] {
  const minLength = options.minLength ?? 1;
  if (!Number.isSafeInteger(minLength) || minLength < 1) {
    throw new Error("minLength must be a positive integer");
  }
  const tokens: string[] = [];
  let buffer = "";
  for (const character of text.normalize("NFC").toLowerCase()) {
    if (!LETTER_OR_NUMBER.test(character)) {
      if (buffer.length >= minLength) tokens.push(buffer);
      buffer = "";
      continue;
    }
    if (CJK.test(character)) {
      if (buffer.length >= minLength) tokens.push(buffer);
      buffer = "";
      if (minLength <= 1) tokens.push(character);
      continue;
    }
    buffer += character;
  }
  if (buffer.length >= minLength) tokens.push(buffer);
  return tokens;
}

export interface Bm25Options {
  /** Term frequency saturation; defaults to 1.2. */
  k1?: number;
  /** Length normalisation strength in [0, 1]; defaults to 0.75. */
  b?: number;
}

export interface Bm25TermStat {
  /** Term frequency in this document. */
  termFrequency: number;
  /** Number of documents containing the term. */
  documentFrequency: number;
}

export interface Bm25Input extends Bm25Options {
  /** Total documents in the collection. */
  documentCount: number;
  /** Length of the scored document, in tokens. */
  documentLength: number;
  /** Mean document length across the collection. */
  averageDocumentLength: number;
  terms: readonly Bm25TermStat[];
}

/** `ln(1 + (N - df + 0.5) / (df + 0.5))`, always positive for `df ≤ N`. */
export function inverseDocumentFrequency(documentCount: number, documentFrequency: number): number {
  assertPositiveInteger(documentCount, "documentCount");
  if (!Number.isSafeInteger(documentFrequency) || documentFrequency < 0 || documentFrequency > documentCount) {
    throw new Error("documentFrequency must be an integer within [0, documentCount]");
  }
  return Math.log(1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5));
}

/**
 * BM25 relevance score. Higher is more relevant — the opposite of vector
 * distance, which is why the return type documents it explicitly.
 *
 * A term with `termFrequency = 0` contributes nothing, so callers can pass every
 * query term without filtering.
 */
export function bm25Score(input: Bm25Input): number {
  const k1 = input.k1 ?? 1.2;
  const b = input.b ?? 0.75;
  if (!(k1 > 0) || !Number.isFinite(k1)) throw new Error("k1 must be a positive finite number");
  if (!(b >= 0 && b <= 1) || !Number.isFinite(b)) throw new Error("b must be within [0, 1]");
  if (!Number.isSafeInteger(input.documentLength) || input.documentLength < 0) throw new Error("documentLength must be a non-negative integer");
  if (!(input.averageDocumentLength > 0) || !Number.isFinite(input.averageDocumentLength)) throw new Error("averageDocumentLength must be a positive finite number");

  const normalisation = k1 * (1 - b + (b * input.documentLength) / input.averageDocumentLength);
  let score = 0;
  for (const term of input.terms) {
    if (term.termFrequency <= 0) continue;
    const idf = inverseDocumentFrequency(input.documentCount, term.documentFrequency);
    score += idf * ((term.termFrequency * (k1 + 1)) / (term.termFrequency + normalisation));
  }
  return score;
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}
