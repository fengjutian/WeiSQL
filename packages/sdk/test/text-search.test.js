import assert from "node:assert/strict";
import test from "node:test";

import { bm25Score, inverseDocumentFrequency, tokenize } from "../dist/index.js";

test("tokenizes ASCII text case-insensitively and splits on punctuation", () => {
  assert.deepEqual(tokenize("The DNA structure, and RNA!"), ["the", "dna", "structure", "and", "rna"]);
  assert.deepEqual(tokenize("v1.2-beta"), ["v1", "2", "beta"]);
  assert.deepEqual(tokenize("   "), []);
  assert.deepEqual(tokenize(""), []);
});

test("normalises compatibility forms before tokenizing", () => {
  // "Cafe" + combining acute and the precomposed form must produce one token.
  assert.deepEqual(tokenize("Cafe\u0301"), ["café"]);
  assert.deepEqual(tokenize("CAFÉ"), ["café"]);
});

test("emits CJK characters as single-character tokens", () => {
  assert.deepEqual(tokenize("DNA 结构"), ["dna", "结", "构"]);
  assert.deepEqual(tokenize("细胞代谢"), ["细", "胞", "代", "谢"]);
  assert.deepEqual(tokenize("ひらがな"), ["ひ", "ら", "が", "な"]);
});

test("applies minLength to every token, including CJK unigrams", () => {
  // A minimum length above 1 deliberately drops single-character CJK tokens.
  assert.deepEqual(tokenize("a ab abc 结构", { minLength: 2 }), ["ab", "abc"]);
});

test("rejects an invalid minLength", () => {
  assert.throws(() => tokenize("x", { minLength: 0 }));
  assert.throws(() => tokenize("x", { minLength: 1.5 }));
});

test("idf decreases as a term becomes more common", () => {
  const rare = inverseDocumentFrequency(1000, 1);
  const common = inverseDocumentFrequency(1000, 500);
  const everywhere = inverseDocumentFrequency(1000, 1000);
  assert.ok(rare > common && common > everywhere && everywhere > 0);
});

test("idf matches the BM25 formula", () => {
  assert.ok(Math.abs(inverseDocumentFrequency(100, 10) - Math.log(1 + 90.5 / 10.5)) < 1e-12);
  assert.throws(() => inverseDocumentFrequency(0, 0));
  assert.throws(() => inverseDocumentFrequency(10, 11));
});

test("bm25 matches a hand-computed value", () => {
  // N=100, df=10, tf=3, dl=50, avgdl=40, k1=1.2, b=0.75
  const score = bm25Score({
    documentCount: 100,
    documentLength: 50,
    averageDocumentLength: 40,
    terms: [{ termFrequency: 3, documentFrequency: 10 }],
  });
  assert.ok(Math.abs(score - 3.376433) < 1e-4, `score was ${score}`);
});

test("bm25 rewards frequency and penalises long documents", () => {
  const base = { documentCount: 100, averageDocumentLength: 40, documentFrequency: 10 };
  const low = bm25Score({ ...base, documentLength: 40, terms: [{ termFrequency: 1, documentFrequency: 10 }] });
  const high = bm25Score({ ...base, documentLength: 40, terms: [{ termFrequency: 5, documentFrequency: 10 }] });
  assert.ok(high > low);

  const short = bm25Score({ ...base, documentLength: 20, terms: [{ termFrequency: 2, documentFrequency: 10 }] });
  const long = bm25Score({ ...base, documentLength: 200, terms: [{ termFrequency: 2, documentFrequency: 10 }] });
  assert.ok(short > long);
});

test("bm25 sums terms, ignores absent terms and rewards rare ones", () => {
  const common = { documentCount: 100, documentLength: 40, averageDocumentLength: 40 };
  const one = bm25Score({ ...common, terms: [{ termFrequency: 2, documentFrequency: 20 }] });
  const two = bm25Score({ ...common, terms: [{ termFrequency: 2, documentFrequency: 20 }, { termFrequency: 2, documentFrequency: 20 }] });
  assert.ok(Math.abs(two - 2 * one) < 1e-12);

  const withAbsent = bm25Score({ ...common, terms: [{ termFrequency: 2, documentFrequency: 20 }, { termFrequency: 0, documentFrequency: 20 }] });
  assert.ok(Math.abs(withAbsent - one) < 1e-12);

  const rare = bm25Score({ ...common, terms: [{ termFrequency: 2, documentFrequency: 1 }] });
  assert.ok(rare > one);
});

test("bm25 honours explicit k1 and b", () => {
  const input = { documentCount: 100, documentLength: 80, averageDocumentLength: 40, terms: [{ termFrequency: 3, documentFrequency: 10 }] };
  const damped = bm25Score({ ...input, b: 0 });
  const normal = bm25Score({ ...input });
  // With b = 0 the document length no longer matters, so a long document scores
  // like an average-length one: higher than with normalisation applied.
  assert.ok(damped > normal);
  assert.throws(() => bm25Score({ ...input, k1: 0 }));
  assert.throws(() => bm25Score({ ...input, b: 1.5 }));
});
