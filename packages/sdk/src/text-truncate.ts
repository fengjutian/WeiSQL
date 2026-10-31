/** Where a fragment was cut. `none` means the text fit the budget unchanged. */
export type TruncationBoundary = "none" | "sentence" | "word" | "character";

export interface TruncatedFragment {
  text: string;
  truncated: boolean;
  boundary: TruncationBoundary;
}

const SENTENCE_TERMINATORS = new Set([".", "!", "?", "。", "！", "？", "\n"]);
const CLOSERS = new Set(["\"", "'", ")", "]", "}", "”", "’", "）", "】", "」"]);

/**
 * Cuts `text` to at most `budget` characters, preferring a sentence boundary,
 * then a word boundary, then a hard cut.
 *
 * A boundary is only accepted when it keeps at least half the budget; otherwise
 * the fragment would be mostly empty and a hard cut carries more information.
 */
export function truncateToBudget(text: string, budget: number): TruncatedFragment {
  if (budget <= 0) return { text: "", truncated: text.length > 0, boundary: "character" };
  if (text.length <= budget) return { text, truncated: false, boundary: "none" };

  const window = text.slice(0, budget);
  const minimum = Math.ceil(budget / 2);

  const sentence = lastSentenceEnd(window);
  if (sentence >= minimum) {
    let end = sentence;
    while (end < window.length && CLOSERS.has(window[end]!)) end++;
    return { text: window.slice(0, end), truncated: true, boundary: "sentence" };
  }

  const space = lastWhitespace(window);
  if (space >= minimum) {
    return { text: window.slice(0, space), truncated: true, boundary: "word" };
  }

  return { text: window, truncated: true, boundary: "character" };
}

/** Index just past the last sentence terminator, or 0 when there is none. */
function lastSentenceEnd(window: string): number {
  for (let index = window.length - 1; index >= 0; index--) {
    if (SENTENCE_TERMINATORS.has(window[index]!)) return index + 1;
  }
  return 0;
}

/** Index of the last whitespace, or 0 when there is none. */
function lastWhitespace(window: string): number {
  for (let index = window.length - 1; index >= 0; index--) {
    if (/\s/.test(window[index]!)) return index;
  }
  return 0;
}
