import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  advanceLiveIndex,
  timeLiveIndex,
  buildCaptureOnsets,
  createLivePositionSource,
  MAX_MATCH_SKIP,
  COACH_MS_PER_WORD,
} from "../public/ui/live-position.js";
import { tokenizeWords } from "../public/ui/karaoke-color.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Canonical target of the matcher tests (book order). */
const TARGET = ["I", "handled", "the", "situation"];

// ---------------------------------------------------------------------------
// advanceLiveIndex — greedy monotonic matcher over rewritten STT interims
// ---------------------------------------------------------------------------

test("advanceLiveIndex: advances to the last target word the interim matched", () => {
  assert.equal(advanceLiveIndex(0, TARGET, "I"), 0);
  assert.equal(advanceLiveIndex(0, TARGET, "I handled"), 1);
  assert.equal(advanceLiveIndex(0, TARGET, "I handled the situation"), 3);
});

test("advanceLiveIndex: tokenization is aligned with tokenizeWords", () => {
  // Same whitespace collapsing as the book renderer.
  assert.equal(advanceLiveIndex(0, TARGET, "  I   handled  "), 1);
  // Case and edge punctuation on either side never break the match: the
  // book renders punctuation inside tokens ("situation." stays one word).
  assert.equal(advanceLiveIndex(0, TARGET, "I HANDLED the Situation."), 3);
  assert.equal(advanceLiveIndex(0, ["don't,", "stop."], "don't stop"), 1);
});

test("advanceLiveIndex: rewritten interims never rewind (monotonic)", () => {
  // Web Speech re-delivers the WHOLE utterance on every result: a shorter
  // rewrite of an already-advanced position must keep the floor.
  assert.equal(advanceLiveIndex(2, TARGET, "I"), 2);
  assert.equal(advanceLiveIndex(3, TARGET, ""), 3);
  assert.equal(advanceLiveIndex(3, TARGET, null), 3);
  assert.equal(advanceLiveIndex(3, TARGET, "garbage words only"), 3);
});

test("advanceLiveIndex: the index is capped at the last word", () => {
  // prev beyond the target (target swapped/shrunk) clamps down…
  assert.equal(advanceLiveIndex(99, TARGET, ""), 3);
  // …and a perfect interim can never point past the last word either.
  assert.equal(advanceLiveIndex(0, TARGET, "I handled the situation"), 3);
  // Invalid prev values fall back to the start of the target.
  assert.equal(advanceLiveIndex(Number.NaN, TARGET, ""), 0);
  assert.equal(advanceLiveIndex(-4, TARGET, ""), 0);
});

test("advanceLiveIndex: fillers and misrecognitions are skipped, not consumed", () => {
  // "um"/"uh" match nothing: the cursor must stay put so the real words
  // behind them still advance the position.
  assert.equal(advanceLiveIndex(0, TARGET, "um I uh handled the situation"), 3);
  // A single misrecognized word mid-utterance only delays it by one token:
  // the next interim recovers and moves past the error.
  assert.equal(advanceLiveIndex(0, TARGET, "I h4ndled the situation"), 3);
});

test("advanceLiveIndex: a spoken token may skip at most MAX_MATCH_SKIP words", () => {
  const words = ["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7"];
  // Skipping one word ahead stays inside the window.
  assert.equal(advanceLiveIndex(0, ["one", "two", "three", "four"], "one three"), 2);
  // Jumping five words ahead (w0 cursor → w6) is treated as noise.
  assert.equal(advanceLiveIndex(0, words, "w0 w6"), 0);
  // The window is the documented constant, not an accident of the loop.
  assert.ok(MAX_MATCH_SKIP >= 1);
});

test("advanceLiveIndex: blank partial or blank target degrades safely", () => {
  assert.equal(advanceLiveIndex(1, TARGET, ""), 1);
  assert.equal(advanceLiveIndex(1, TARGET, undefined), 1);
  assert.equal(advanceLiveIndex(5, [], "anything at all"), 0);
  assert.equal(advanceLiveIndex(0, null, "anything at all"), 0);
});

// ---------------------------------------------------------------------------
// timeLiveIndex — elapsed capture time → word index over the coach's onsets
// ---------------------------------------------------------------------------

test("timeLiveIndex: maps elapsed time onto the last onset that passed", () => {
  const onsets = [0, 500, 1000, 1500];
  assert.equal(timeLiveIndex(TARGET, onsets, 0), 0);
  assert.equal(timeLiveIndex(TARGET, onsets, 499), 0);
  assert.equal(timeLiveIndex(TARGET, onsets, 500), 1);
  assert.equal(timeLiveIndex(TARGET, onsets, 999), 1);
  assert.equal(timeLiveIndex(TARGET, onsets, 1000), 2);
  assert.equal(timeLiveIndex(TARGET, onsets, 1500), 3);
});

test("timeLiveIndex: caps at the last word and floors at the first", () => {
  const onsets = [0, 500, 1000, 1500];
  assert.equal(timeLiveIndex(TARGET, onsets, 999999), 3, "past the last onset");
  // Onsets longer than the target can never index outside the book.
  assert.equal(timeLiveIndex(["a", "b"], [0, 100, 200, 300], 999999), 1);
  // Elapsed time before the first onset (and invalid values) = first word.
  assert.equal(timeLiveIndex(TARGET, [200, 700, 1000], 0), 0);
  assert.equal(timeLiveIndex(TARGET, onsets, -50), 0);
  assert.equal(timeLiveIndex(TARGET, onsets, Number.NaN), 0);
});

test("timeLiveIndex: no schedule → null (degradation signal)", () => {
  assert.equal(timeLiveIndex(TARGET, null, 100), null);
  assert.equal(timeLiveIndex(TARGET, [], 100), null);
  assert.equal(timeLiveIndex(TARGET, undefined, 100), null);
});

// ---------------------------------------------------------------------------
// buildCaptureOnsets — pause-aware schedule for a capture whose read had none
// ---------------------------------------------------------------------------

test("buildCaptureOnsets: one onset per token, starting at 0, monotonic", () => {
  const target = "I handled the situation well";
  const onsets = buildCaptureOnsets(target);
  assert.ok(onsets, "a real sentence always gets a schedule");
  assert.equal(onsets.length, tokenizeWords(target).length);
  assert.equal(onsets[0], 0);
  for (let i = 1; i < onsets.length; i++) {
    assert.ok(onsets[i] >= onsets[i - 1], `onset ${i} went backwards`);
  }
});

test("buildCaptureOnsets: keeps the coach's clause pause wider than one word", () => {
  // A comma mid-sentence inserts the 220 ms clause pause of splitForTts, so
  // the gap across the boundary exceeds the plain per-word cadence — the
  // schedule pauses where the user is expected to pause too.
  const target = "I handled the situation, and then I measured the impact.";
  const onsets = buildCaptureOnsets(target);
  assert.ok(onsets);
  const boundaryGap = onsets[4] - onsets[3];
  assert.ok(boundaryGap > COACH_MS_PER_WORD, `gap ${boundaryGap} ≤ ${COACH_MS_PER_WORD}`);
});

test("buildCaptureOnsets: blank target → null", () => {
  assert.equal(buildCaptureOnsets(""), null);
  assert.equal(buildCaptureOnsets("   "), null);
  assert.equal(buildCaptureOnsets(null), null);
});

// ---------------------------------------------------------------------------
// createLivePositionSource — the { start, stop, onWord } contract
// ---------------------------------------------------------------------------

test("time source: arms at word 0, follows the injected clock, caps, stops", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let clock = 0;
  const source = createLivePositionSource({
    kind: "time",
    targetTokens: ["a", "b", "c", "d"],
    wordOnsetsMs: [0, 500, 1000, 1500],
    intervalMs: 100,
    now: () => clock,
  });
  const seen: number[] = [];
  source.onWord((i) => seen.push(i));
  source.start();
  assert.deepEqual(seen, [0], "arming paints the first word");
  clock = 700;
  t.mock.timers.tick(100);
  assert.deepEqual(seen, [0, 1]);
  clock = 99999; // past the last onset → capped, then silent
  t.mock.timers.tick(100);
  assert.deepEqual(seen, [0, 1, 3]);
  source.stop();
  clock = 200000;
  t.mock.timers.tick(100);
  assert.deepEqual(seen, [0, 1, 3], "no emissions after stop()");
});

test("interim source: feeds advance the index, rewrites never rewind", () => {
  // Holder object (not a `let`): the handler is installed by a callback TS
  // cannot see running, so a plain variable would stay narrowed to null.
  const feed: { current: ((partial: string) => void) | null } = { current: null };
  let unsubscribed = 0;
  const source = createLivePositionSource({
    kind: "interim",
    targetTokens: TARGET,
    register: (handler) => {
      feed.current = handler;
      return () => {
        unsubscribed++;
        feed.current = null;
      };
    },
  });
  const seen: number[] = [];
  source.onWord((i) => seen.push(i));
  source.start();
  assert.deepEqual(seen, [0]);
  feed.current?.("I handled");
  assert.deepEqual(seen, [0, 1]);
  feed.current?.("I"); // rewritten shorter: stays put
  assert.deepEqual(seen, [0, 1]);
  feed.current?.("I handled the situation");
  assert.deepEqual(seen, [0, 1, 3]);
  source.stop();
  assert.equal(unsubscribed, 1, "stop() releases the interim registration");
  assert.deepEqual(seen, [0, 1, 3], "no emissions after stop()");
});

test("interim source: every start() is a fresh capture (position resets)", () => {
  const feed: { current: ((partial: string) => void) | null } = { current: null };
  const source = createLivePositionSource({
    kind: "interim",
    targetTokens: TARGET,
    register: (handler) => {
      feed.current = handler;
      return () => {
        feed.current = null;
      };
    },
  });
  const seen: number[] = [];
  source.onWord((i) => seen.push(i));
  source.start();
  feed.current?.("I handled the situation");
  source.start(); // a new PTT press (e.g. after a discarded tap) restarts at 0
  assert.deepEqual(seen, [0, 3, 0]);
});

test("degraded sources emit nothing (no onsets, no feed, no target)", () => {
  const seen: number[] = [];
  const collect = (source: { onWord: (cb: (i: number) => void) => void; start: () => void; stop: () => void }) => {
    source.onWord((i) => seen.push(i));
    source.start();
    source.stop();
  };
  collect(createLivePositionSource({ kind: "time", targetTokens: TARGET, wordOnsetsMs: null }));
  collect(createLivePositionSource({ kind: "interim", targetTokens: TARGET, register: null }));
  collect(createLivePositionSource({ kind: "time", targetTokens: [], wordOnsetsMs: [0, 100] }));
  assert.deepEqual(seen, [], "a source without usable data never emits");
});

test("sources tolerate lifecycle edge cases (double stop, no listener)", () => {
  const source = createLivePositionSource({ kind: "interim", targetTokens: TARGET, register: null });
  source.stop();
  source.stop();
  source.start(); // degraded: still emits nothing, still must not throw
  source.stop();
});

// ---------------------------------------------------------------------------
// Integration pin: the practice view wires the source into the PTT capture
// ---------------------------------------------------------------------------

test("practice-view: live position armed by the PTT press and torn down in finally", () => {
  const viewSrc = readFileSync(join(repoRoot, "public", "ui", "practice-view.js"), "utf8");
  assert.match(
    viewSrc,
    /kind === "full" \? createLiveCapturePosition\(/,
    "only the full-answer capture arms a live position (fragments already scroll)",
  );
  assert.match(
    viewSrc,
    /livePosition\?\.begin\(\)/,
    "the position is (re)armed on every PTT press, not at arm time",
  );
  assert.match(
    viewSrc,
    /onInterim: \(text\) => livePosition\?\.feed\(text\)/,
    "the browser route feeds the rewritten interims into the source",
  );
  assert.match(
    viewSrc,
    /livePosition\?\.dispose\(\)/,
    "captureAttempt disposes the live position on every exit path",
  );
});
