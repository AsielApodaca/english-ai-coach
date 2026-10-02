import { test } from "node:test";
import assert from "node:assert/strict";

import {
  splitForTts,
  SHORT_PAUSE_MS,
  MEDIUM_PAUSE_MS,
  LONG_PAUSE_MS,
  MAX_SEGMENTS,
  SHORT_TEXT_MAX_WORDS,
} from "../src/lib/prosody.ts";

/** Every pause of a split must be one of the three spec classes. */
function assertPauseClasses(pauses: number[]): void {
  for (const p of pauses) {
    assert.ok(
      p === SHORT_PAUSE_MS || p === MEDIUM_PAUSE_MS || p === LONG_PAUSE_MS,
      `unexpected pause ${p}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Short text: never split
// ---------------------------------------------------------------------------

test("splitForTts: text up to 4 words is returned as a single segment", () => {
  const { segments, pausesMs } = splitForTts("Repeat after me");
  assert.deepEqual(segments, ["Repeat after me"]);
  assert.equal(pausesMs.length, segments.length);
  assert.equal(pausesMs[0], LONG_PAUSE_MS);
});

test("splitForTts: a 4-word sentence keeps the exact wording (no split)", () => {
  const { segments } = splitForTts("This is fine, right?");
  // 4 tokens → still under the short-text threshold.
  assert.equal(segments.length, 1);
  assert.equal(segments[0], "This is fine, right?");
});

// ---------------------------------------------------------------------------
// Clause split + ms per punctuation type
// ---------------------------------------------------------------------------

test("splitForTts: comma closes a clause with a short pause (180–250 ms)", () => {
  const text = "Take your time, breathe, and start speaking when you are ready.";
  const { segments, pausesMs } = splitForTts(text);
  assert.ok(segments.length >= 3, `expected ≥3 segments, got ${segments.length}`);
  assertPauseClasses(pausesMs);
  assert.ok(pausesMs[0] >= 180 && pausesMs[0] <= 250, `comma pause ${pausesMs[0]}`);
  assert.ok(pausesMs[0] === SHORT_PAUSE_MS);
  // The reconstructed text keeps every word (segments are a trimmed partition).
  assert.equal(segments.join(" ").replace(/\s+/g, " ").trim(), text);
});

test("splitForTts: period closes a clause with a medium pause (350–450 ms)", () => {
  const text = "This is the first full sentence here. And this is the second one.";
  const { segments, pausesMs } = splitForTts(text);
  assert.equal(segments.length, 2);
  assert.ok(pausesMs[0] >= 350 && pausesMs[0] <= 450, `period pause ${pausesMs[0]}`);
  assert.equal(pausesMs[0], MEDIUM_PAUSE_MS);
});

test("splitForTts: question mark closes a clause with a medium pause", () => {
  const text = "How are you feeling about this topic today? I can help with that.";
  const { segments, pausesMs } = splitForTts(text);
  assert.equal(segments.length, 2);
  assert.ok(pausesMs[0] >= 350 && pausesMs[0] <= 450, `question pause ${pausesMs[0]}`);
});

test("splitForTts: semicolon, colon and em dash all use the short pause", () => {
  const semi = splitForTts("You should try this one; or maybe that other plan instead today.");
  assert.equal(semi.pausesMs[0], SHORT_PAUSE_MS);

  const colon = splitForTts("Consider this one thing carefully: the plan we agreed on yesterday.");
  assert.equal(colon.pausesMs[0], SHORT_PAUSE_MS);

  const dash = splitForTts("Wait \u2014 hold on a second please before you answer that question.");
  assert.equal(dash.pausesMs[0], SHORT_PAUSE_MS);
});

test("splitForTts: the final segment always gets the long handover pause (600–700 ms)", () => {
  const text = "We will start with a simple question. Tell me about your last project in detail.";
  const { segments, pausesMs } = splitForTts(text);
  assert.equal(pausesMs.length, segments.length);
  const last = pausesMs[pausesMs.length - 1];
  assert.ok(last >= 600 && last <= 700, `final pause ${last}`);
  assert.equal(last, LONG_PAUSE_MS);
});

// ---------------------------------------------------------------------------
// Abbreviations and numbers stay intact
// ---------------------------------------------------------------------------

test("splitForTts: 'Mr.' does not split the clause", () => {
  const text = "Mr. Smith went to London today, and then he called his wife back home.";
  const { segments } = splitForTts(text);
  const first = segments[0];
  assert.match(first, /^Mr\. Smith/, `"${first}" must keep the title intact`);
  assert.equal(segments.length, 2, "only the comma splits this line");
});

test("splitForTts: decimals and thousands separators stay inside one segment", () => {
  const text = "The value is 3.5 points, above the 1,234 baseline we measured yesterday.";
  const { segments } = splitForTts(text);
  const joined = segments.join(" ");
  assert.match(joined, /3\.5/, "3.5 must not be split at the dot");
  assert.match(joined, /1,234/, "1,234 must not be split at the comma");
  assert.equal(segments.length, 2, "only the real comma splits this line");
});

test("splitForTts: 'e.g.' stays glued to its example", () => {
  const text = "Use a clear everyday topic, e.g. system design, when you practice daily.";
  const { segments } = splitForTts(text);
  const withEg = segments.find((s) => /e\.g\./.test(s));
  assert.ok(withEg, `no segment contains "e.g.": ${segments.join(" | ")}`);
});

test("splitForTts: single-letter initials do not split (J. R. R.)", () => {
  const text = "Have you read J. R. R. Tolkien before, or maybe somebody else entirely?";
  const { segments } = splitForTts(text);
  const first = segments[0];
  assert.match(first, /J\. R\. R\. Tolkien/, `"${first}" must keep the initials`);
});

// ---------------------------------------------------------------------------
// Structural guarantees
// ---------------------------------------------------------------------------

test("splitForTts: never produces empty segments", () => {
  const samples = [
    "Hello,, world. This line starts with stray punctuation marks though.",
    "Wait here, , my friend, then we will all go home together tonight.",
    "How are you doing today, my friend? I am doing great thanks as well!",
  ];
  for (const text of samples) {
    const { segments, pausesMs } = splitForTts(text);
    for (const s of segments) assert.ok(s.trim().length > 0, `empty segment in "${text}"`);
    assert.equal(pausesMs.length, segments.length);
  }
});

test("splitForTts: segment count is capped at MAX_SEGMENTS", () => {
  const clauses = Array.from({ length: 30 }, (_, i) => `clause number ${i + 1} here`);
  const text = clauses.join(", ") + " and the very end.";
  const { segments, pausesMs } = splitForTts(text);
  assert.ok(segments.length <= MAX_SEGMENTS, `got ${segments.length} segments`);
  assert.ok(segments.length >= 2, "the long line must still be split");
  assert.equal(pausesMs.length, segments.length);
  // The overflow text is not dropped: the tail clause is still spoken.
  assert.ok(segments[segments.length - 1].includes("very end"));
});

test("splitForTts: a line without any punctuation is a single segment", () => {
  const text = "this is a very long line with absolutely no punctuation inside it at all";
  const { segments, pausesMs } = splitForTts(text);
  assert.equal(segments.length, 1);
  assert.equal(segments[0], text);
  assert.deepEqual(pausesMs, [LONG_PAUSE_MS]);
});

test("splitForTts: empty and whitespace-only input produce no segments", () => {
  assert.deepEqual(splitForTts(""), { segments: [], pausesMs: [] });
  assert.deepEqual(splitForTts("   \n\t "), { segments: [], pausesMs: [] });
});

test("splitForTts: a closing quote stays with its sentence (`.\" Then`)", () => {
  const text = 'She said "I am fine about the whole thing." Then she left the office quickly.';
  const { segments } = splitForTts(text);
  assert.equal(segments.length, 2);
  assert.match(segments[0], /\."\s*$/, `first segment was "${segments[0]}"`);
});

test("splitForTts: content inside brackets/parentheses is not split", () => {
  const text = "We compared the two plans (fast, cheap, good) and picked the second one today.";
  const { segments } = splitForTts(text);
  const withParens = segments.find((s) => s.includes("("));
  assert.ok(withParens, "the parenthetical must stay in one segment");
  assert.ok(withParens.includes("fast, cheap, good"), "no split inside the parentheses");
});

test("splitForTts: pause classes cover the three spec ranges on a long mixed line", () => {
  const text =
    "First, warm up slowly; then read the model answer. Does that sound reasonable to you? Perfect, let us begin now.";
  const { segments, pausesMs } = splitForTts(text);
  assert.equal(pausesMs.length, segments.length);
  assertPauseClasses(pausesMs);
  assert.ok(pausesMs.includes(SHORT_PAUSE_MS), "expected a short pause from ,/;");
  const last = pausesMs[pausesMs.length - 1];
  assert.equal(last, LONG_PAUSE_MS);
  assert.ok(SHORT_TEXT_MAX_WORDS >= 4, "short-text threshold is documented");
});

// ---------------------------------------------------------------------------
// Degenerate inputs (review fixes #5 and #6)
// ---------------------------------------------------------------------------

test("splitForTts: punctuation-only input still honors the >= 1 segment contract", () => {
  // Every comma boundary is dropped as "no speech before it", which used to
  // leave ZERO segments — the server answered 400 for non-empty input.
  const text = ", , , , ,";
  const { segments, pausesMs } = splitForTts(text);
  assert.deepEqual(segments, [text], "the whole source comes back as one segment");
  assert.deepEqual(pausesMs, [LONG_PAUSE_MS]);
  assert.equal(pausesMs.length, segments.length);
});

test("splitForTts: a dash between digits is a number range, not a clause boundary", () => {
  const spacedHyphen = "The daily limit is 10 - 20 requests for every team today.";
  const hyphen = splitForTts(spacedHyphen);
  assert.ok(
    hyphen.segments.some((s) => s.includes("10 - 20")),
    `number range was split apart: ${JSON.stringify(hyphen.segments)}`,
  );

  const emDash = "Expect anywhere from 10 \u2014 20 minutes of waiting on weekdays here.";
  const dash = splitForTts(emDash);
  assert.ok(
    dash.segments.some((s) => s.includes("10 \u2014 20")),
    `number range was split apart: ${JSON.stringify(dash.segments)}`,
  );

  // A dash between WORDS is still a clause boundary (short pause).
  const words = splitForTts("Bring the reports, wait \u2014 hold on a second before answering please.");
  assert.equal(words.pausesMs[0], SHORT_PAUSE_MS);
});
