import { test } from "node:test";
import assert from "node:assert/strict";
import { alignWords, alignTextWords, levenshtein } from "../src/lib/align.ts";
import type { WhisperWord } from "../src/lib/whisper.ts";

/**
 * Build word-timestamped tokens with strictly increasing ms:
 * startMs = i * 500, endMs = i * 500 + 400 (so spoken index i spans [i*500, i*500+400]).
 */
function spoken(text: string): WhisperWord[] {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word, i) => ({ word, startMs: i * 500, endMs: i * 500 + 400 }));
}

/** Number of display words in a target fragment (= the score denominator). */
function targetCount(target: string): number {
  return target.trim().split(/\s+/).filter(Boolean).length;
}

/** Statuses of the target positions (first n entries; extras are appended after them). */
function targetStatuses(words: { status: string }[], n: number): string[] {
  return words.slice(0, n).map((w) => w.status);
}

// --- Green -----------------------------------------------------------------

test("alignWords: perfect match → every target word green, score 100", () => {
  const r = alignWords(spoken("I handled the situation well"), "I handled the situation well");
  assert.equal(r.score, 100);
  assert.deepEqual(targetStatuses(r.words, 5), ["green", "green", "green", "green", "green"]);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.extra, []);
  // Matched words keep their own spoken timestamps.
  assert.deepEqual({ startMs: r.words[0].startMs, endMs: r.words[0].endMs }, { startMs: 0, endMs: 400 });
  assert.deepEqual({ startMs: r.words[4].startMs, endMs: r.words[4].endMs }, { startMs: 2000, endMs: 2400 });
});

// --- Amber -----------------------------------------------------------------

test("alignWords: near miss 'handel' → amber, not green, not red", () => {
  const r = alignWords(spoken("The system handel the request"), "The system handled the request");
  assert.equal(r.words[2].status, "amber");
  assert.equal(r.words[2].word, "handled");
  assert.deepEqual(targetStatuses(r.words, 5), ["green", "green", "amber", "green", "green"]);
  assert.ok(r.missing.length === 0 && r.extra.length === 0);
});

test("alignWords: edit distance 1 ('handle') → amber (near path)", () => {
  const r = alignWords(spoken("The system handle the request"), "The system handled the request");
  assert.equal(r.words[2].status, "amber");
  assert.notEqual(r.words[2].status, "green");
  assert.notEqual(r.words[2].status, "red");
});

test("alignWords: character transposition 'haev' → amber", () => {
  const r = alignWords(spoken("I haev worked"), "I have worked");
  assert.deepEqual(targetStatuses(r.words, 3), ["green", "amber", "green"]);
  assert.equal(r.words[1].word, "have");
});

test("alignWords: partial overlap 'hand' (shared bigram) → amber", () => {
  const r = alignWords(spoken("The system hand the request"), "The system handled the request");
  assert.equal(r.words[2].status, "amber");
});

test("alignWords: partial overlap 'handl' → amber", () => {
  const r = alignWords(spoken("The system handl the request"), "The system handled the request");
  assert.equal(r.words[2].status, "amber");
});

test("alignWords: contraction expanded in speech ('I've' vs 'I have') → green", () => {
  const r = alignWords(spoken("I have done it"), "I've done it");
  assert.equal(r.score, 100);
  assert.deepEqual(targetStatuses(r.words, 3), ["green", "green", "green"]);
  // Both sub-tokens matched: the word spans the union of their timestamps.
  assert.deepEqual({ startMs: r.words[0].startMs, endMs: r.words[0].endMs }, { startMs: 0, endMs: 900 });
});

test("alignWords: contraction half-spoken ('I've' vs 'I') → amber (partial)", () => {
  const r = alignWords(spoken("I"), "I've done it");
  assert.equal(r.words[0].status, "amber");
  assert.equal(r.words[0].word, "I've");
  // Unspoken remainder of the target is red and inherits the last matched ts.
  assert.deepEqual(targetStatuses(r.words, 3), ["amber", "red", "red"]);
  assert.equal(r.score, 33);
});

test("alignWords: forcedAmberWords downgrades green → amber, others stay green", () => {
  const r = alignWords(spoken("I have worked hard"), "I have worked hard", { forcedAmberWords: ["have"] });
  assert.deepEqual(targetStatuses(r.words, 4), ["green", "amber", "green", "green"]);
  assert.equal(r.score, 100);
});

test("alignWords: word-order transposition reconciles — no missing+extra double penalty", () => {
  // Speech order "I worked have" vs target "I have worked". The LCS maps
  // "I have" in order (exact normalized match ⇒ green per spec); "worked" is
  // backfilled by the reconciliation pass (said but out of place ⇒ amber).
  const r = alignWords(spoken("I worked have"), "I have worked");
  assert.deepEqual(targetStatuses(r.words, 3), ["green", "green", "amber"]);
  assert.equal(r.words[2].word, "worked");
  // Reconciled word keeps the timestamps of the spoken token it claimed.
  assert.deepEqual({ startMs: r.words[2].startMs, endMs: r.words[2].endMs }, { startMs: 500, endMs: 900 });
  // Key invariant: the word is never simultaneously missing and extra.
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.extra, []);
  assert.equal(r.score, 100);
});

// --- Red -------------------------------------------------------------------

test("alignWords: missing target word → red, inherits last matched word timestamps", () => {
  const r = alignWords(spoken("I handled the well"), "I handled the situation well");
  assert.equal(r.words[3].word, "situation");
  assert.equal(r.words[3].status, "red");
  // "the" (spoken index 2) spans [1000, 1400]; the red word inherits it.
  assert.deepEqual({ startMs: r.words[3].startMs, endMs: r.words[3].endMs }, { startMs: 1000, endMs: 1400 });
  assert.ok(r.missing.includes("situation"));
  assert.deepEqual(targetStatuses(r.words, 5), ["green", "green", "green", "red", "green"]);
  assert.equal(r.score, 80);
});

test("alignWords: extra filler tokens appended at the END as red with their own timestamps", () => {
  const r = alignWords(spoken("uh difficult situation hmm"), "difficult situation");
  // Target positions keep their order first…
  assert.deepEqual(targetStatuses(r.words, 2), ["green", "green"]);
  assert.equal(r.words[0].word, "difficult");
  assert.equal(r.words[1].word, "situation");
  // …then extras, red, each with the timestamps of its spoken token.
  assert.equal(r.words.length, 4);
  assert.deepEqual(r.words[2], { word: "uh", status: "red", startMs: 0, endMs: 400 });
  assert.deepEqual(r.words[3], { word: "hmm", status: "red", startMs: 1500, endMs: 1900 });
  assert.deepEqual(r.extra, ["uh", "hmm"]);
  // Extras do not lower the score (denominator = target words only).
  assert.equal(r.score, 100);
});

test("alignWords: repeated target word — one spoken token never claims two positions", () => {
  const r = alignWords(spoken("the problem"), "the the problem");
  const theStatuses = r.words.filter((w) => w.word === "the").map((w) => w.status).sort();
  assert.deepEqual(theStatuses, ["green", "red"]);
  assert.equal(r.words[2].word, "problem");
  assert.equal(r.words[2].status, "green");
  assert.deepEqual(r.missing, ["the"]);
  assert.equal(r.score, 67);
  // The unmatched first "the" had no previous match → timestamps default to 0.
  const redThe = r.words.find((w) => w.word === "the" && w.status === "red")!;
  assert.deepEqual({ startMs: redThe.startMs, endMs: redThe.endMs }, { startMs: 0, endMs: 0 });
});

// --- Edges -----------------------------------------------------------------

test("alignWords: empty spoken → all target words red, score 0, timestamps 0", () => {
  const r = alignWords([], "hello world");
  assert.deepEqual(targetStatuses(r.words, 2), ["red", "red"]);
  assert.equal(r.score, 0);
  assert.deepEqual(r.missing, ["hello", "world"]);
  assert.deepEqual(r.words.map((w) => [w.startMs, w.endMs]), [[0, 0], [0, 0]]);
});

test("alignWords: empty target (and empty spoken) → words [], score 0", () => {
  const r = alignWords([], "");
  assert.deepEqual(r.words, []);
  assert.equal(r.score, 0);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.extra, []);
});

test("alignWords: empty target with spoken speech → every spoken word appended red, score 0", () => {
  const r = alignWords(spoken("hello world"), "");
  assert.equal(r.score, 0);
  assert.deepEqual(r.words, [
    { word: "hello", status: "red", startMs: 0, endMs: 400 },
    { word: "world", status: "red", startMs: 500, endMs: 900 },
  ]);
  assert.deepEqual(r.extra, ["hello", "world"]);
});

// --- Score ↔ words coherence (property) ------------------------------------

test("alignWords: score == round(100 * (green+amber target words) / target words)", () => {
  // Rule: the denominator is the number of TARGET display words (extras
  // appended at the end are red and excluded); numerator counts target
  // positions (first n entries of words[]) that are green or amber.
  const cases: Array<[spoken: string, target: string]> = [
    ["I handled it well", "I handled it well"], // 100
    ["I handled the well", "I handled the situation well"], // 80
    ["uh difficult situation hmm", "difficult situation"], // 100 (extras don't weigh)
    ["I worked have", "I have worked"], // 100 (reconciled counts as matched)
    ["the problem", "the the problem"], // 67
    ["handel", "handled with care"], // 33 (only "handel"→"handled" partial)
    ["", "one two three"], // 0
    ["the system handel the request uh", "the system handled the request"], // 100
    ["I", "I've done it"], // 33 (half contraction amber counts as matched)
  ];
  for (const [sp, tg] of cases) {
    const r = alignWords(spoken(sp), tg);
    const n = targetCount(tg);
    const targetWords = r.words.slice(0, n);
    const good = targetWords.filter((w) => w.status === "green" || w.status === "amber").length;
    const expected = n === 0 ? 0 : Math.round((100 * good) / n);
    assert.equal(r.score, expected, `spoken="${sp}" target="${tg}"`);
    // Appended extras live after the target positions and are always red.
    assert.ok(r.words.slice(n).every((w) => w.status === "red"), `spoken="${sp}"`);
    assert.equal(r.words.length, n + r.extra.length, `spoken="${sp}" target="${tg}"`);
  }
});

// --- Levenshtein ------------------------------------------------------------

test("levenshtein: equal → 0; single insert/delete/substitute → 1", () => {
  assert.equal(levenshtein("same", "same"), 0);
  assert.equal(levenshtein("ab", "abc"), 1); // insert
  assert.equal(levenshtein("abc", "ab"), 1); // delete
  assert.equal(levenshtein("cat", "cut"), 1); // substitute
  assert.equal(levenshtein("kitten", "sitting"), 3);
});

test("levenshtein: transposition costs 2 (align handles it via isTransposition)", () => {
  assert.equal(levenshtein("have", "haev"), 2);
  // …and the aligner still colors the transposed word amber (not red).
  const r = alignWords(spoken("I haev"), "I have");
  assert.equal(r.words[1].status, "amber");
});

test("alignWords: transposition + filler — out-of-place word amber, filler stays extra", () => {
  // Both fix aspects together: the transposed "worked" is reconciled (amber,
  // never missing+extra) while the genuine filler "uh" remains an extra.
  const r = alignWords(spoken("I worked have uh"), "I have worked");
  assert.deepEqual(targetStatuses(r.words, 3), ["green", "green", "amber"]);
  assert.equal(r.words[2].word, "worked");
  assert.deepEqual({ startMs: r.words[2].startMs, endMs: r.words[2].endMs }, { startMs: 500, endMs: 900 });
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.extra, ["uh"]);
  assert.equal(r.words[3].status, "red"); // appended filler keeps its own ts
  assert.deepEqual({ startMs: r.words[3].startMs, endMs: r.words[3].endMs }, { startMs: 1500, endMs: 1900 });
  assert.equal(r.score, 100); // score counts green + amber target words
});

// ---------------------------------------------------------------------------
// alignTextWords — text-only fallback (feature 105, no whisper)
// ---------------------------------------------------------------------------

test("alignTextWords: transposition + filler — out-of-place red & not missing, filler in extra", () => {
  const r = alignTextWords("I worked have uh", "I have worked");
  assert.deepEqual(r.words.map((w) => w.status), ["green", "green", "red"]);
  assert.equal(r.words[2].word, "worked");
  // The reconciled word is excluded from BOTH missing and extra (never both).
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.extra, ["uh"]);
  // Score counts only greens → the out-of-place word does not count.
  assert.equal(r.score, 67);
});

test("alignTextWords: perfect match → every target word green, score 100", () => {
  const r = alignTextWords("I handled the situation well", "I handled the situation well");
  assert.equal(r.score, 100);
  assert.deepEqual(r.words.map((w) => w.status), ["green", "green", "green", "green", "green"]);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.extra, []);
});

test("alignTextWords: missing target word → red, score drops", () => {
  const r = alignTextWords("I handled the well", "I handled the situation well");
  assert.equal(r.words[3].word, "situation");
  assert.equal(r.words[3].status, "red");
  assert.deepEqual(r.words.map((w) => w.status), ["green", "green", "green", "red", "green"]);
  assert.deepEqual(r.missing, ["situation"]);
  assert.equal(r.score, 80);
});

test("alignTextWords: extra spoken words are reported but not rendered on the line", () => {
  const r = alignTextWords("uh difficult situation hmm", "difficult situation");
  assert.deepEqual(r.words.map((w) => w.status), ["green", "green"]);
  assert.equal(r.words.length, 2); // extras never appear in words[]
  assert.deepEqual(r.extra, ["uh", "hmm"]);
  assert.equal(r.score, 100); // extras do not lower the score
});

test("alignTextWords: contraction expanded in speech ('I've' vs 'I have') → green", () => {
  const r = alignTextWords("I have done it", "I've done it");
  assert.equal(r.score, 100);
  assert.deepEqual(r.words.map((w) => w.status), ["green", "green", "green"]);
});

test("alignTextWords: contraction half-spoken ('I've' vs 'I') → red (partial)", () => {
  const r = alignTextWords("I", "I've done it");
  assert.equal(r.words[0].word, "I've");
  assert.equal(r.words[0].status, "red");
  assert.deepEqual(r.words.map((w) => w.status), ["red", "red", "red"]);
  assert.equal(r.score, 0);
});

test("alignTextWords: word-order transposition — out-of-place word is red, never missing+extra", () => {
  const r = alignTextWords("I worked have", "I have worked");
  assert.deepEqual(r.words.map((w) => w.status), ["green", "green", "red"]);
  assert.equal(r.words[2].word, "worked");
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.extra, []);
  assert.equal(r.score, 67);
});

test("alignTextWords: repeated filler duplicate still surfaces once in extra", () => {
  const r = alignTextWords("bye bye", "bye");
  assert.equal(r.words.length, 1);
  assert.equal(r.words[0].status, "green");
  assert.equal(r.score, 100);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.extra, ["bye"]);
});

test("alignTextWords: empty spoken → all target words red, score 0", () => {
  const r = alignTextWords("", "hello world");
  assert.deepEqual(r.words.map((w) => w.status), ["red", "red"]);
  assert.equal(r.score, 0);
  assert.deepEqual(r.missing, ["hello", "world"]);
});

test("alignTextWords: empty target → words [], score 0", () => {
  const r = alignTextWords("hello world", "");
  assert.deepEqual(r.words, []);
  assert.equal(r.score, 0);
  assert.deepEqual(r.extra, ["hello", "world"]);
});

test("alignTextWords: score == round(100 * green target words / target words)", () => {
  const cases: Array<[spoken: string, target: string]> = [
    ["I handled it well", "I handled it well"], // 100
    ["I handled the well", "I handled the situation well"], // 80
    ["uh difficult situation hmm", "difficult situation"], // 100 (extras don't weigh)
    ["I worked have", "I have worked"], // 67 (out-of-place word is red textually)
    ["", "one two three"], // 0
    ["I", "I've done it"], // 0 (half contraction is red textually)
  ];
  for (const [sp, tg] of cases) {
    const r = alignTextWords(sp, tg);
    const n = targetCount(tg);
    const good = r.words.filter((w) => w.status === "green").length;
    const expected = n === 0 ? 0 : Math.round((100 * good) / n);
    assert.equal(r.score, expected, `spoken="${sp}" target="${tg}"`);
    assert.equal(r.words.length, n, `spoken="${sp}" target="${tg}"`);
  }
});
