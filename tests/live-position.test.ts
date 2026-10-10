import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  advanceLiveIndex,
  matchLiveWords,
  createLivePositionSource,
  MAX_MATCH_SKIP,
} from "../public/ui/live-position.js";
import { tokenizeWords } from "../public/ui/karaoke-color.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Canonical target of the matcher tests (book order). */
const TARGET = ["I", "handled", "the", "situation"];

/**
 * Indented body of a top-level `function <name>(...) { ... }` in
 * practice-view.js (same source-level pin approach as book-scroll-guard).
 */
function functionBody(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in practice-view.js`);
  const open = src.indexOf("{", start);
  const close = src.indexOf("\n}", open);
  assert.ok(open >= 0 && close > open, `${name} must have a readable body`);
  return src.slice(open + 1, close);
}

// ---------------------------------------------------------------------------
// matchLiveWords — THE single walk of the live layer (spoken + missing + active)
// ---------------------------------------------------------------------------

test("matchLiveWords: perfect match → active at the last word, every word spoken", () => {
  const m = matchLiveWords(TARGET, "I handled the situation");
  assert.equal(m.index, 3);
  assert.deepEqual(m.spoken, [true, true, true, true]);
});

test("matchLiveWords: partial match → spoken flags before the active word", () => {
  const m = matchLiveWords(TARGET, "I handled");
  assert.equal(m.index, 1);
  assert.deepEqual(m.spoken, [true, true, false, false]);
});

test("matchLiveWords: a skipped target word is missing, not spoken", () => {
  // "handled" was never said: the walk jumps from cursor 1 straight to "the"
  // (index 2), so word 1 sits BEFORE the active index and unspoken — the view
  // paints exactly that gap as `kw-live-missing`.
  const m = matchLiveWords(TARGET, "I the situation");
  assert.equal(m.index, 3);
  assert.deepEqual(m.spoken, [true, false, true, true]);
});

test("matchLiveWords: nothing matched → active 0, nothing spoken", () => {
  const empty = [false, false, false, false];
  assert.deepEqual(matchLiveWords(TARGET, "um uh filler"), { index: 0, spoken: empty });
  assert.deepEqual(matchLiveWords(TARGET, ""), { index: 0, spoken: empty });
  assert.deepEqual(matchLiveWords(TARGET, null), { index: 0, spoken: empty });
  assert.deepEqual(matchLiveWords([], "anything at all"), { index: 0, spoken: [] });
  assert.deepEqual(matchLiveWords(null, "anything at all"), { index: 0, spoken: [] });
});

test("matchLiveWords: i > index is never spoken; spoken mirrors the target length", () => {
  const m = matchLiveWords(TARGET, "I");
  assert.equal(m.index, 0);
  assert.equal(m.spoken.length, tokenizeWords(TARGET.join(" ")).length);
  assert.deepEqual(m.spoken, [true, false, false, false]);
  for (let i = m.index + 1; i < m.spoken.length; i++) {
    assert.equal(m.spoken[i], false, `spoken[${i}] > index must stay false`);
  }
});

test("matchLiveWords: tokenization, fillers and the MAX_MATCH_SKIP window", () => {
  // Same normalization as the book: whitespace collapsing, case and edge
  // punctuation never break the match; contractions keep their apostrophe.
  assert.equal(matchLiveWords(TARGET, "  I   handled  ").index, 1);
  assert.equal(matchLiveWords(TARGET, "I HANDLED the Situation.").index, 3);
  assert.equal(matchLiveWords(["don't,", "stop."], "don't stop").index, 1);
  // Fillers/misrecognitions are skipped, not consumed.
  const full = matchLiveWords(TARGET, "um I uh handled the situation");
  assert.equal(full.index, 3);
  assert.deepEqual(full.spoken, [true, true, true, true]);
  // Skipping one word ahead stays inside the window; a five-word jump is noise.
  assert.equal(matchLiveWords(["one", "two", "three", "four"], "one three").index, 2);
  const words = ["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7"];
  assert.equal(matchLiveWords(words, "w0 w6").index, 0);
  assert.ok(MAX_MATCH_SKIP >= 1);
});

// ---------------------------------------------------------------------------
// matchLiveWords — EXPANDED edge cases (feature 121 v2)
// ---------------------------------------------------------------------------

test("matchLiveWords: repeated words — second occurrence does not double-match", () => {
  // The walk advances the cursor past each match, so a repeated word later
  // in the target is not matched again.
  const t = ["a", "b", "c", "d"];
  const m = matchLiveWords(t, "a a");
  assert.equal(m.index, 0);
  // Only the first "a" is matched; the second "a" is a filler after cursor
  // has moved past it, so it does not set spoken[1] = true.
  assert.deepEqual(m.spoken, [true, false, false, false]);
});

test("matchLiveWords: spoken[i] is never true for i > index", () => {
  // Invariants: spoken mirrors the target length and words beyond index
  // are always false.
  const t = ["a", "b", "c", "d", "e"];
  // Only word 0 matched → index 0, only spoken[0] = true
  const m = matchLiveWords(t, "a");
  assert.equal(m.index, 0);
  assert.deepEqual(m.spoken, [true, false, false, false, false]);
  for (let i = m.index + 1; i < m.spoken.length; i++) {
    assert.equal(m.spoken[i], false, `spoken[${i}] must be false when i > index`);
  }
});

test("matchLiveWords: MAX_MATCH_SKIP boundary — word at index 4 not matched from cursor=0", () => {
  // MAX_MATCH_SKIP = 3: from cursor=0 the window covers target[0..3] (4 positions).
  // A word at index 4 is outside that window and is treated as a skip/noise.
  const t = ["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7"];
  // Single word "w4" from cursor=0: window is [0,4) → indices 0,1,2,3 only.
  const m = matchLiveWords(t, "w4");
  assert.equal(m.index, 0); // w4 not found, cursor stays at 0
  assert.deepEqual(m.spoken, [false, false, false, false, false, false, false, false]);
});

test("matchLiveWords: MAX_MATCH_SKIP boundary — word at index 3 IS matched from cursor=0", () => {
  // From cursor=0 the window covers target[0..3] (inclusive), so index 3 is the
  // furthest reachable word within MAX_MATCH_SKIP=3.
  const t = ["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7"];
  const m = matchLiveWords(t, "w3");
  assert.equal(m.index, 3); // w3 found at the window boundary
  assert.deepEqual(m.spoken, [false, false, false, true, false, false, false, false]);
});

test("matchLiveWords: MAX_MATCH_SKIP boundary — after matching w0, w4 IS reachable from cursor=1", () => {
  // After matching w0 at index 0, cursor advances to 1. From cursor=1 the window
  // covers target[1..4], so w4 at index 4 is within reach.
  const t = ["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7"];
  const m = matchLiveWords(t, "w0 w4");
  // w0 matched at index 0, then w4 matched at index 4 → index=4
  assert.equal(m.index, 4);
  assert.deepEqual(m.spoken, [true, false, false, false, true, false, false, false]);
});

test("matchLiveWords: spoken[] consistency with index across successive feeds via advanceLiveIndex", () => {
  // Monotonic high-water: feeding partials through advanceLiveIndex should never
  // unwind the index or un-mark words already spoken.
  const t = ["a", "b", "c", "d"];
  let idx;

  // Feed 1: "a b" → advanceLiveIndex from 0 → index 1, spoken[0,1]=true
  idx = advanceLiveIndex(0, t, "a b");
  assert.equal(idx, 1);
  // Verify spoken invariant: words beyond index are false
  const m1 = matchLiveWords(t, "a b");
  assert.deepEqual(m1.spoken, [true, true, false, false]);
  for (let i = m1.index + 1; i < m1.spoken.length; i++) {
    assert.equal(m1.spoken[i], false, `spoken[${i}] must be false when i > index`);
  }

  // Feed 2: just "c" → advanceLiveIndex from 1 → max(1, newIndex).
  // matchLiveWords from cursor=0 finds "c" at index 2 → newIndex=2 → max(1,2)=2
  idx = advanceLiveIndex(idx, t, "c");
  assert.equal(idx, 2);
  const m2 = matchLiveWords(t, "c");
  assert.deepEqual(m2.spoken, [false, false, true, false]);
  for (let i = m2.index + 1; i < m2.spoken.length; i++) {
    assert.equal(m2.spoken[i], false, `spoken[${i}] must be false when i > index`);
  }

  // Feed 3: "a" again → monotonic floor prevents rewind
  idx = advanceLiveIndex(idx, t, "a");
  assert.equal(idx, 2, "monotonic floor: max(2, newIndex_from_a) must stay at 2");
  const m3 = matchLiveWords(t, "a");
  // matchLiveWords from cursor=0 finds "a" at index 0 → newIndex=0 → max(2,0)=2
  assert.deepEqual(m3.spoken, [true, false, false, false]);
});

test("matchLiveWords: monotonic high-water across successive feeds via advanceLiveIndex", () => {
  // The view's funnel uses advanceLiveIndex which takes max(prev, newIndex).
  // This test verifies that successive feeds respect the monotonic floor (never rewind).
  const t = ["a", "b", "c", "d", "e"];

  // Feed 1: user says "a" → index 0
  let idx = advanceLiveIndex(0, t, "a");
  assert.equal(idx, 0);

  // Feed 2: user says "b" → index should advance to 1 (max(0, 1) = 1)
  idx = advanceLiveIndex(idx, t, "b");
  assert.equal(idx, 1);

  // Feed 3: user says "a" again (rewritten shorter) → index stays at 1
  // (max(1, 0) = 1, since matchLiveWords from cursor=0 finds "a" at index 0)
  idx = advanceLiveIndex(idx, t, "a");
  assert.equal(idx, 1, "monotonic floor must not rewind");

  // Feed 4: user says "c" → index advances to 2 (max(1, 2) = 2)
  idx = advanceLiveIndex(idx, t, "c");
  assert.equal(idx, 2);
});

test("matchLiveWords: blank partial and blank target degrade safely", () => {
  // Already covered but let's be explicit about the invariants
  const m = matchLiveWords(TARGET, "");
  assert.equal(m.index, 0);
  assert.deepEqual(m.spoken, [false, false, false, false]);

  const m2 = matchLiveWords(TARGET, undefined);
  assert.equal(m2.index, 0);
  assert.deepEqual(m2.spoken, [false, false, false, false]);

  const m3 = matchLiveWords(TARGET, null);
  assert.equal(m3.index, 0);
  assert.deepEqual(m3.spoken, [false, false, false, false]);
});

// ---------------------------------------------------------------------------
// advanceLiveIndex — monotonic wrapper over matchLiveWords
// ---------------------------------------------------------------------------

test("advanceLiveIndex: advances to the last target word the interim matched", () => {
  assert.equal(advanceLiveIndex(0, TARGET, "I"), 0);
  assert.equal(advanceLiveIndex(0, TARGET, "I handled"), 1);
  assert.equal(advanceLiveIndex(0, TARGET, "I handled the situation"), 3);
});

test("advanceLiveIndex: tokenization is aligned with tokenizeWords", () => {
  assert.equal(advanceLiveIndex(0, TARGET, "  I   handled  "), 1);
  assert.equal(advanceLiveIndex(0, TARGET, "I HANDLED the Situation."), 3);
  assert.equal(advanceLiveIndex(0, ["don't,", "stop."], "don't stop"), 1);
});

test("advanceLiveIndex: rewritten interims never rewind (monotonic)", () => {
  // Web Speech re-delivers the WHOLE utterance on every result, and a server
  // partial may say less than the previous one: the floor must hold.
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

test("advanceLiveIndex: a spoken token may skip at most MAX_MATCH_SKIP words", () => {
  const words = ["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7"];
  assert.equal(advanceLiveIndex(0, ["one", "two", "three", "four"], "one three"), 2);
  assert.equal(advanceLiveIndex(0, words, "w0 w6"), 0);
});

test("advanceLiveIndex: blank partial or blank target degrades safely", () => {
  assert.equal(advanceLiveIndex(1, TARGET, ""), 1);
  assert.equal(advanceLiveIndex(1, TARGET, undefined), 1);
  assert.equal(advanceLiveIndex(5, [], "anything at all"), 0);
  assert.equal(advanceLiveIndex(0, null, "anything at all"), 0);
});

// ---------------------------------------------------------------------------
// createLivePositionSource — the { start, stop, onWord } contract
// (kinds "interim" = Web Speech, "streaming" = server partials; same mechanics)
// ---------------------------------------------------------------------------

/** register/unregister double feeding the handler the test drives. */
function registrar() {
  const feed: { current: ((partial: string) => void) | null } = { current: null };
  let unsubscribed = 0;
  const register = (handler: (partial: string) => void) => {
    feed.current = handler;
    return () => {
      unsubscribed++;
      feed.current = null;
    };
  };
  return { feed, register, unsubscribed: () => unsubscribed };
}

for (const kind of ["interim", "streaming"] as const) {
  test(`${kind} source: feeds advance the index, rewrites never rewind`, () => {
    const reg = registrar();
    const source = createLivePositionSource({ kind, targetTokens: TARGET, register: reg.register });
    const seen: number[] = [];
    source.onWord((i) => seen.push(i));
    source.start();
    assert.deepEqual(seen, [0]);
    reg.feed.current?.("I handled");
    assert.deepEqual(seen, [0, 1]);
    reg.feed.current?.("I"); // rewritten shorter: stays put
    assert.deepEqual(seen, [0, 1]);
    reg.feed.current?.("I handled the situation");
    assert.deepEqual(seen, [0, 1, 3]);
    source.stop();
    assert.equal(reg.unsubscribed(), 1, "stop() releases the registration");
    assert.deepEqual(seen, [0, 1, 3], "no emissions after stop()");
  });

  test(`${kind} source: every start() is a fresh capture (position resets)`, () => {
    const reg = registrar();
    const source = createLivePositionSource({ kind, targetTokens: TARGET, register: reg.register });
    const seen: number[] = [];
    source.onWord((i) => seen.push(i));
    source.start();
    reg.feed.current?.("I handled the situation");
    source.start(); // a new PTT press (e.g. after a discarded tap) restarts at 0
    assert.deepEqual(seen, [0, 3, 0]);
  });
}

test("degraded sources emit nothing (no register, no target, unknown kind)", () => {
  const seen: number[] = [];
  const collect = (source: { onWord: (cb: (i: number) => void) => void; start: () => void; stop: () => void }) => {
    source.onWord((i) => seen.push(i));
    source.start();
    source.stop();
  };
  collect(createLivePositionSource({ kind: "interim", targetTokens: TARGET, register: null }));
  collect(createLivePositionSource({ kind: "streaming", targetTokens: TARGET, register: null }));
  collect(createLivePositionSource({ kind: "streaming", targetTokens: [], register: () => () => {} }));
  // Unknown kind (the deleted v1 clock source, or any future typo): the type
  // lies on purpose — anything outside interim/streaming must degrade.
  const bogusKind = "time" as "interim" | "streaming";
  collect(createLivePositionSource({ kind: bogusKind, targetTokens: TARGET, register: () => () => {} }));
  assert.deepEqual(seen, [], "a source without usable data never emits");
});

test("sources tolerate lifecycle edge cases (double stop, no listener)", () => {
  const source = createLivePositionSource({ kind: "streaming", targetTokens: TARGET, register: null });
  source.stop();
  source.stop();
  source.start(); // degraded: still emits nothing, still must not throw
  source.stop();
});

// ---------------------------------------------------------------------------
// Integration pins: the practice view wires the source into the PTT capture
// ---------------------------------------------------------------------------

const viewSrc = readFileSync(join(repoRoot, "public", "ui", "practice-view.js"), "utf8");

test("practice-view: live position armed by the PTT press and torn down in finally", () => {
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

test("practice-view: whisper route drives the streaming source via the window pump", () => {
  assert.match(
    viewSrc,
    /kind: stt === "browser" \? "interim" : "streaming"/,
    "the STT route picks the source kind (browser=interim, whisper=streaming)",
  );
  assert.match(
    viewSrc,
    /stt === "whisper" \? createWindowPump\(\(\) => recorder, feed\)/,
    "the whisper route starts the cumulative-window pump feeding the same funnel",
  );
  assert.match(
    viewSrc,
    /livePosition\?\.attachRecorder\?\.\(recorder\)/,
    "waitForUserRecording hands the pump the capture's recorder",
  );
  const pumpBody = functionBody(viewSrc, "createWindowPump");
  assert.match(pumpBody, /snapshotWav\(\)/, "windows are recorder snapshots (copies)");
  assert.match(pumpBody, /AbortController/, "the request is abortable on release/dispose");
  assert.match(pumpBody, /console\.warn/, "a failure warns exactly once and disables the pump");
  assert.match(pumpBody, /\.catch\(\(\) => \{/, "fetch failures land in a catch");
  // The only `throw` allowed inside the pump is the promise-internal one the
  // .catch below it consumes; nothing may propagate to captureAttempt.
  const catchAt = pumpBody.indexOf(".catch(");
  const catchBody = pumpBody.slice(catchAt, pumpBody.indexOf(".finally", catchAt));
  assert.doesNotMatch(
    catchBody,
    /throw /,
    "pump errors must never rethrow toward captureAttempt (they would trigger the whisper→browser fallback)",
  );
});

test("practice-view: live scroll rests at the ANTEPENULTIMATE visible row (two-row buffer)", () => {
  assert.match(viewSrc, /const LIVE_SCROLL_MASK_PX = 48/, "mask band mirrored from the book's scroll-padding-block");
  assert.match(viewSrc, /const LIVE_SCROLL_KEPT_ROWS = 2/, "two visible rows kept below the reading row");
  const scrollBody = functionBody(viewSrc, "scrollLiveWord");
  assert.match(
    scrollBody,
    /bookRect\.bottom - LIVE_SCROLL_MASK_PX - LIVE_SCROLL_KEPT_ROWS \* rowHeight/,
    "rest line = book bottom − mask − kept rows × measured row height (IPA on/off)",
  );
  assert.match(scrollBody, /book\.scrollTop \+ overflow/, "scrolls exactly the overflow (minimal distance)");
  assert.match(scrollBody, /behavior: "smooth"/, "smooth scrolling, like the previous nearest-scroll");
  assert.match(
    viewSrc,
    /if \(active\) scrollLiveWord\(active\.parentElement\)/,
    "the paint drives the live scroll through the active word's wrap",
  );
  assert.doesNotMatch(viewSrc, /parentElement\?\.scrollIntoView/, "the old nearest-scroll of the live paint is gone");
});

test("invariant: evaluation uses the single full WAV from stop(), never window snapshots", () => {
  // The evaluation path (captureAttempt → submitAudio) receives the blob that
  // settleWithBlob built from recorder.stop() — the one full WAV. Windows
  // (snapshotWav) are copies that feed ONLY /api/transcribe-partial.
  const attemptBody = functionBody(viewSrc, "captureAttempt");
  assert.match(attemptBody, /submitAudio\(blob, target, kind\)/);
  assert.doesNotMatch(attemptBody, /snapshotWav/, "captureAttempt never evaluates a window");
  assert.match(
    viewSrc,
    /const blob = recorder \? recorder\.stop\(\)/,
    "the evaluated blob is exactly what recorder.stop() produced",
  );
  const submitBody = functionBody(viewSrc, "submitAudio");
  assert.doesNotMatch(submitBody, /snapshotWav|transcribe-partial/, "submitAudio posts only to /api/attempt");
  const pumpBody = functionBody(viewSrc, "createWindowPump");
  assert.match(pumpBody, /transcribe-partial/, "windows go to the partial endpoint, nowhere else");
});
