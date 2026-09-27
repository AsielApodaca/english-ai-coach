import { test } from "node:test";
import assert from "node:assert/strict";

import { tokenizeWords, lineColorStatuses, fragmentWordCounts } from "../public/ui/karaoke-color.js";

/** Shorthand for an aligned word (only the status matters here). */
function w(status: string | undefined) {
  return { word: "x", status };
}

// --- tokenizeWords ----------------------------------------------------------

test("tokenizeWords: empty / null / whitespace-only → []", () => {
  assert.deepEqual(tokenizeWords(""), []);
  assert.deepEqual(tokenizeWords("   "), []);
  assert.deepEqual(tokenizeWords(null), []);
  assert.deepEqual(tokenizeWords(undefined), []);
});

test("tokenizeWords: extra whitespace collapses to one word each", () => {
  assert.deepEqual(tokenizeWords("  I   handled the   situation  "), ["I", "handled", "the", "situation"]);
  assert.deepEqual(tokenizeWords("one\ntwo\tthree"), ["one", "two", "three"]);
});

test("tokenizeWords: contractions and punctuation stay inside the word", () => {
  assert.deepEqual(tokenizeWords("I've done it"), ["I've", "done", "it"]);
  assert.deepEqual(tokenizeWords("don't, stop."), ["don't,", "stop."]);
});

// --- lineColorStatuses (regression: bug B, cross-line painting) -------------

test("lineColorStatuses: a short fragment never paints spans of a longer line", () => {
  // 4 aligned words (fragment of 4) against a 12-span line: only the first 4
  // spans get a status, the remaining 8 stay white.
  const statuses = lineColorStatuses([w("green"), w("amber"), w("red"), w("green")], 12);
  assert.equal(statuses.length, 12);
  assert.deepEqual(statuses.slice(0, 4), ["green", "amber", "red", "green"]);
  assert.deepEqual(statuses.slice(4), new Array(8).fill(null));
});

test("lineColorStatuses: aligner extras beyond spanCount are dropped", () => {
  // words[] = 2 target words + 4 appended filler extras (always red).
  const words = [w("green"), w("red"), w("red"), w("red"), w("red"), w("red")];
  assert.deepEqual(lineColorStatuses(words, 2), ["green", "red"]);
  // And a longer-than-needed spanCount is padded, never overflowed.
  assert.equal(lineColorStatuses(words, 3).length, 3);
});

test("lineColorStatuses: unknown or missing status → null (span stays white)", () => {
  const statuses = lineColorStatuses([w("blue"), w(undefined), { word: "x" }, w("green")], 4);
  assert.deepEqual(statuses, [null, null, null, "green"]);
});

test("lineColorStatuses: no words → every span null", () => {
  assert.deepEqual(lineColorStatuses([], 3), [null, null, null]);
  assert.deepEqual(lineColorStatuses(null, 2), [null, null]);
  assert.deepEqual(lineColorStatuses(undefined, 1), [null]);
});

test("lineColorStatuses: invalid spanCount → []", () => {
  assert.deepEqual(lineColorStatuses([w("green")], -1), []);
  assert.deepEqual(lineColorStatuses([w("green")], -0.5), []);
  assert.deepEqual(lineColorStatuses([w("green")], 1.5), []);
  assert.deepEqual(lineColorStatuses([w("green")], Number.NaN), []);
});

// --- fragmentWordCounts -----------------------------------------------------

test("fragmentWordCounts: word count per fragment, in order", () => {
  const fragments = [
    { text: "I handled it well" },
    { text: "  the   system  " },
    { text: "" },
    { text: "one two three four" },
  ];
  assert.deepEqual(fragmentWordCounts(fragments), [4, 2, 0, 4]);
});

test("fragmentWordCounts: empty / missing fragment lists → []", () => {
  assert.deepEqual(fragmentWordCounts([]), []);
  assert.deepEqual(fragmentWordCounts(null), []);
  assert.deepEqual(fragmentWordCounts(undefined), []);
  assert.deepEqual(fragmentWordCounts([{ text: "" }, {}]), [0, 0]);
});

test("fragmentWordCounts: matches tokenizeWords of each fragment text", () => {
  const fragments = [{ text: "Let's ship it" }, { text: "and then measure" }];
  assert.deepEqual(
    fragmentWordCounts(fragments),
    fragments.map((f) => tokenizeWords(f.text).length),
  );
});
