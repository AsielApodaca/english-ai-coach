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

test("wordMatch: extra filler words reported but missing dominates", () => {
  const m = wordMatch("difficult situation", "uh difficult situation");
  assert.equal(m.missing.length, 0);
  assert.ok(m.extra.includes("uh"));
  assert.ok(m.score >= 80);
});

test("wordMatch: case and punctuation insensitive", () => {
  const m = wordMatch("Difficult situation", "difficult situation,");
  assert.equal(m.score, 100);
});

test("tokenize: handles empty string", () => {
  assert.deepEqual(tokenize("   "), []);
});