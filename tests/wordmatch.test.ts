import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlankTranscript, normalize, tokenize, wordMatch } from "../src/lib/practice/practice.ts";

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

test("normalize: hyphens act as separators (end-to-end ≡ end to end)", () => {
  assert.equal(normalize("the end-to-end tests"), "the end to end tests");
  assert.equal(normalize("the end - to - end tests"), "the end to end tests");
  assert.deepEqual(tokenize("end-to-end"), ["end", "to", "end"]);
  // A lone "-" token (whisper punctuation artifact) disappears entirely.
  assert.deepEqual(tokenize("end - to - end"), ["end", "to", "end"]);
});

test("wordMatch: hyphenated target matches spaced speech (no missing/extra)", () => {
  const m = wordMatch("My main task is automating the end-to-end tests.", "My main task is automating the end to end tests.");
  assert.equal(m.score, 100);
  assert.deepEqual(m.missing, []);
  assert.deepEqual(m.extra, []);
});

test("wordMatch: full -sow transcript of the reported bug scores 100", () => {
  // Real `whisper-cli -oj -ml 1 -sow` output for "My main task is automating
  // the end to end tests." — before -sow this arrived as "autom ating … end - to - end".
  const m = wordMatch(
    "My main task is automating the end-to-end tests.",
    "My main task is automating the end-to-end tests.",
  );
  assert.equal(m.score, 100);
  assert.deepEqual(m.missing, []);
  assert.deepEqual(m.extra, []);
});

test("normalize: whisper annotations ([BLANK_AUDIO]) are not speech", () => {
  assert.equal(normalize("[BLANK_AUDIO]"), "");
  assert.deepEqual(tokenize("[BLANK_AUDIO]"), []);
  assert.deepEqual(tokenize("My main task is [BLANK_AUDIO]"), ["my", "main", "task", "is"]);
});

test("isBlankTranscript: silence/annotations vs real speech", () => {
  assert.equal(isBlankTranscript("[BLANK_AUDIO]"), true);
  assert.equal(isBlankTranscript(""), true);
  assert.equal(isBlankTranscript("   "), true);
  assert.equal(isBlankTranscript("..."), true);
  assert.equal(isBlankTranscript("automating the tests"), false);
});

test("wordMatch: blank transcript ([BLANK_AUDIO]) → 0 with no phantom extras", () => {
  const m = wordMatch("I am currently working on a project", "[BLANK_AUDIO]");
  assert.equal(m.score, 0);
  assert.deepEqual(m.extra, []);
  assert.equal(m.missing.length, 7);
});

test("tokenize: handles empty string", () => {
  assert.deepEqual(tokenize("   "), []);
});