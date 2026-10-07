import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlankTranscript, normalize, tokenize, wordMatch } from "../src/lib/practice/practice.ts";

test("normalize: lowercases, strips punctuation, keeps letters/numbers", () => {
  assert.equal(normalize("Once in this company, I had this situation!"), "once in this company i had this situation");
});

test("normalize: expands contractions", () => {
  assert.equal(normalize("I won't can't I've it's"), "i will not cannot i have it s");
});

test("normalize: numbers become English words (digits ≡ spelled-out)", () => {
  assert.equal(normalize("I saved 200 dollars"), "i saved two hundred dollars");
  assert.equal(normalize("2,000"), "two thousand");
  assert.equal(normalize("3.5"), "three point five");
  assert.equal(normalize("21st"), "twenty first");
  assert.equal(normalize("1,000th"), "one thousandth");
  assert.deepEqual(tokenize("200"), ["two", "hundred"]);
});

test("normalize: digits glued to letters are not numbers", () => {
  assert.equal(normalize("covid19 and 3D"), "covid19 and 3d");
  assert.equal(normalize("1990s"), "1990s");
});

test("normalize: value symbols become the words a reader says", () => {
  assert.equal(normalize("faster by 40%"), "faster by forty percent");
  assert.deepEqual(tokenize("40%"), ["forty", "percent"]);
  assert.equal(normalize("$50"), "fifty dollars");
  assert.equal(normalize("50$"), "fifty dollars"); // whisper sometimes suffixes the symbol
  assert.equal(normalize("$1"), "one dollar");
  assert.equal(normalize("Tom & Jerry"), "tom and jerry");
  assert.deepEqual(tokenize("R&D"), ["r", "and", "d"]);
});

test("wordMatch: percent and currency symbols ≡ their spoken form", () => {
  const percent = wordMatch(
    "shipping quote times became faster by forty percent",
    "shipping quote times became faster by 40%",
  );
  assert.equal(percent.score, 100);
  assert.deepEqual(percent.missing, []);
  assert.deepEqual(percent.extra, []);
  // Whisper splits "40%" into two words ("40", "%") just as often.
  const split = wordMatch("faster by forty percent", "faster by 40 %");
  assert.equal(split.score, 100);
  const currency = wordMatch("it costs fifty dollars", "it costs $50");
  assert.equal(currency.score, 100);
  assert.deepEqual(currency.missing, []);
  assert.deepEqual(currency.extra, []);
  assert.equal(wordMatch("it costs $50", "it costs fifty dollars").score, 100);
  assert.equal(wordMatch("Tom and Jerry", "Tom & Jerry").score, 100);
});

test("wordMatch: digits and spelled-out numbers are the same words", () => {
  // Whisper writes "200" where the fragment says "two hundred": without number
  // normalization the target came back missing + "200" flagged as extra.
  const m = wordMatch("I saved two hundred dollars", "I saved 200 dollars");
  assert.equal(m.score, 100);
  assert.deepEqual(m.missing, []);
  assert.deepEqual(m.extra, []);
  const reverse = wordMatch("I saved 200 dollars", "I saved two hundred dollars");
  assert.equal(reverse.score, 100);
  assert.deepEqual(reverse.missing, []);
  assert.deepEqual(reverse.extra, []);
});

test("wordMatch: a number outside the fragment is still extra content", () => {
  // Extras are normalized tokens, so "200" surfaces (and weighs) exactly like
  // the spelled-out "two hundred" would.
  const m = wordMatch("I handled it", "I handled it 200");
  assert.deepEqual(m.missing, []);
  assert.deepEqual(m.extra, ["two", "hundred"]);
  assert.equal(m.score, 33);
  assert.deepEqual(wordMatch("I handled it", "I handled it two hundred").extra, ["two", "hundred"]);
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