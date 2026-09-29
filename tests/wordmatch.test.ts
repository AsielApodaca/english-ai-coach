import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, tokenize, wordMatch } from "../src/lib/practice.ts";

test("normalize: lowercases, strips punctuation, keeps letters/numbers", () => {
  assert.equal(normalize("Once in this company, I had this situation!"), "once in this company i had this situation");
});

test("normalize: expands contractions", () => {
  assert.equal(normalize("I won't can't I've it's"), "i will not cannot i have it s");
});

test("wordMatch: perfect match scores 100 and no gaps", () => {
  const m = wordMatch("I handled it well", "I handled it well");
  assert.equal(m.score, 100);
  assert.equal(m.missing.length, 0);
  assert.equal(m.extra.length, 0);
});

test("wordMatch: missing word lowers score and reports it", () => {
  const m = wordMatch("I handled the situation well", "I handled the well");
  assert.ok(m.score < 100);
  assert.ok(m.missing.includes("situation"), `missing=${m.missing}`);
});

test("wordMatch: filler words are reported as extra but never penalize", () => {
  const m = wordMatch("difficult situation", "uh difficult situation");
  assert.equal(m.missing.length, 0);
  assert.ok(m.extra.includes("uh"));
  assert.equal(m.score, 100);
});

test("wordMatch: invented words outside the fragment lower the score", () => {
  const m = wordMatch(
    "Im currently working on a project that improves our test coverage",
    "I like chocolate Im currently working on making chocolates a project that improves our test coverage",
  );
  assert.equal(m.missing.length, 0);
  assert.deepEqual(m.extra, ["i", "like", "chocolate", "making", "chocolates"]);
  // 5 invented words subtract from the 11 matched → 55, not 100.
  assert.equal(m.score, 55);
  assert.ok(m.score < 70);
});

test("wordMatch: case and punctuation insensitive", () => {
  const m = wordMatch("Difficult situation", "difficult situation,");
  assert.equal(m.score, 100);
});

test("wordMatch: repeated target word is reported (and scored) as an extra", () => {
  const m = wordMatch("bye", "bye bye");
  assert.deepEqual(m.missing, []);
  assert.deepEqual(m.extra, ["bye"]);
  assert.equal(m.score, 0);
});

test("tokenize: handles empty string", () => {
  assert.deepEqual(tokenize("   "), []);
});