import assert from "node:assert/strict";
import test from "node:test";

import { truncateToBudget } from "../dist/index.js";

test("returns the text unchanged when it fits the budget", () => {
  assert.deepEqual(truncateToBudget("short text", 20), { text: "short text", truncated: false, boundary: "none" });
  assert.deepEqual(truncateToBudget("", 5), { text: "", truncated: false, boundary: "none" });
});

test("prefers a sentence boundary", () => {
  assert.deepEqual(truncateToBudget("Hello world. This is next.", 14), {
    text: "Hello world.",
    truncated: true,
    boundary: "sentence",
  });
  // A sentence cut keeps closing punctuation and quotes.
  assert.deepEqual(truncateToBudget('She said "stop." Then left.', 17), {
    text: 'She said "stop."',
    truncated: true,
    boundary: "sentence",
  });
});

test("handles CJK sentence terminators", () => {
  assert.deepEqual(truncateToBudget("第一句。第二句。", 6), {
    text: "第一句。",
    truncated: true,
    boundary: "sentence",
  });
});

test("falls back to a word boundary without sentence punctuation", () => {
  assert.deepEqual(truncateToBudget("alpha beta gamma delta", 14), {
    text: "alpha beta",
    truncated: true,
    boundary: "word",
  });
});

test("falls back to a hard cut when no boundary is close enough", () => {
  // The only space is too early to keep half of the budget.
  assert.deepEqual(truncateToBudget("a bcdefghijklmn", 5), {
    text: "a bcd",
    truncated: true,
    boundary: "character",
  });
  assert.deepEqual(truncateToBudget("abcdefghij", 5), {
    text: "abcde",
    truncated: true,
    boundary: "character",
  });
});

test("never returns more than the budget, and zero budget yields nothing", () => {
  for (const budget of [1, 2, 3, 5, 9, 17]) {
    const result = truncateToBudget("alpha. beta gamma delta.", budget);
    assert.ok(result.text.length <= budget, `budget ${budget} produced ${result.text.length} characters`);
  }
  assert.deepEqual(truncateToBudget("alpha", 0), { text: "", truncated: true, boundary: "character" });
});
