/**
 * Live position of the user's capture (feature 121 / CU2).
 *
 * Pure, DOM-free engine behind the provisional karaoke paint (`kw-live`) and
 * the auto-scroll of the model answer while the mic is held: it answers "which
 * word of the target is the user on right now?" and pushes the index to the
 * view, which owns every DOM effect.
 *
 * Two interchangeable sources under ONE contract (`LivePositionSource`):
 *
 *   - `time` — maps elapsed capture time onto the coach's word onsets
 *     (`buildWordStarts` from `karaoke-schedule.js`). Universal baseline: it
 *     works on every STT route, including the default local-whisper one,
 *     with zero cost. The user's pace may drift from the coach's; monotonic
 *     clamping + the post-hoc traffic light (106/116) absorb the error.
 *   - `interim` — refines the position with the live Web Speech transcript
 *     (`browser-stt.js` already emits `onInterim`): every rewritten interim is
 *     matched against the target with the same monotonic greedy matcher.
 *
 * Chunked-whisper streaming is deliberately NOT implemented: the contract
 * above would absorb it later without touching the consumers (plan 121).
 *
 * Invariants (spec 121):
 *   - MONOTONIC — within one armed source the index only moves forward: STT
 *     interims get rewritten shorter and a schedule may run ahead, and a
 *     rewinding position would make the scroll vibrate.
 *   - CAPPED — the index never leaves `[0, targetTokens.length - 1]`.
 *   - DEGRADES — a source armed without usable data (no onsets, no interim
 *     feed, no target) emits NOTHING; the capture keeps working exactly as
 *     it did before this feature.
 *
 * `start()` is (re)arm: every push-to-talk press restarts the position at the
 * first word, so an accidental tap discarded by PTT (111) never inherits the
 * position of the tap before it.
 */

import { tokenizeWords } from "./karaoke-color.js";
import { buildWordStarts } from "./karaoke-schedule.js";
import { splitForTts } from "../speech/prosody.js";

/** Position-signal cadence of the `time` source (ms between two ticks). */
export const LIVE_TICK_MS = 100;

/**
 * Nominal aloud cadence of the coach (ms per spoken word) used to rebuild a
 * word schedule for a capture whose read carried no measured one — the full
 * answer is read with plain `speak()` (no `buildWordStarts` of its own), so
 * the capture schedule is synthesized from the SAME clause split the TTS
 * used, spread over this cadence (~170 wpm). The estimate only positions the
 * provisional paint/scroll; the exact word colors come from 106/116 post-hoc.
 */
export const COACH_MS_PER_WORD = 350;

/**
 * Max target tokens one spoken token may skip when matching forward: absorbs
 * a word the user skipped or that STT missed without letting a stray token
 * jump the position far ahead of what is being said.
 */
export const MAX_MATCH_SKIP = 3;

/**
 * Live position source contract (feature 121). The consumers (`kw-live` paint
 * + auto-scroll in the practice view) only ever see this shape.
 *
 * @typedef {Object} LivePositionSource
 * @property {() => void} start - (Re)arm: reset the position to the first
 *   word and begin emitting. Safe to call repeatedly — each call restarts.
 * @property {() => void} stop - Stop emitting and release resources (timer /
 *   interim registration). Safe to call twice; nothing emits afterwards.
 * @property {(cb: (index: number) => void) => void} onWord - Register the
 *   listener of active-word indices (the last registration wins). Only
 *   changes of the index are emitted.
 */

/**
 * Normalize a token for matching: lower-case, punctuation stripped from the
 * edges only (contractions like `don't` keep their apostrophe). Mirrors the
 * tolerance the post-hoc aligner needs, at the scale of one word.
 *
 * @param {unknown} token - raw token from either side of the match
 * @returns {string} the comparable form ("" for blank/non-string input)
 */
function normalizeToken(token) {
  return String(token ?? "")
    .toLowerCase()
    .replace(/^[^a-z0-9']+|[^a-z0-9']+$/g, "");
}

/**
 * Clamp any number into a valid word index of a target of `last + 1` words.
 *
 * @param {unknown} value - candidate index (truncated toward zero)
 * @param {number} last - index of the last word (>= 0)
 * @returns {number} an integer in `[0, last]`
 */
function clampWordIndex(value, last) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n) || n < 0) return 0;
  return n > last ? last : n;
}

/**
 * Advance the active-word index against a rewritten STT interim (feature 121).
 *
 * Greedy forward matcher: the partial is tokenized with the SAME tokenizer
 * the book renders with (`tokenizeWords`), each spoken token searches the
 * target ahead of the cursor inside a {@link MAX_MATCH_SKIP} window, and a
 * token that matches nothing (filler, misrecognition) is skipped WITHOUT
 * consuming the cursor. The result never goes backwards: an interim rewritten
 * shorter — Web Speech re-delivers the whole utterance on every result — can
 * only keep or raise the index.
 *
 * @param {number} prevIndex - current position (the floor of the result)
 * @param {Array<string>|null|undefined} targetTokens - target words, in book order
 * @param {unknown} spokenPartial - latest STT text (finals + interims)
 * @returns {number} the new index, in `[0, targetTokens.length - 1]`
 *   (0 for an empty target — callers must not arm a source without words)
 */
export function advanceLiveIndex(prevIndex, targetTokens, spokenPartial) {
  const tokens = Array.isArray(targetTokens) ? targetTokens : [];
  const last = Math.max(0, tokens.length - 1);
  const prev = clampWordIndex(prevIndex, last);
  const spoken = tokenizeWords(spokenPartial).map(normalizeToken).filter(Boolean);
  if (!spoken.length || !tokens.length) return prev;
  const target = tokens.map(normalizeToken);
  let cursor = 0;
  let matched = -1;
  for (const word of spoken) {
    const limit = Math.min(target.length, cursor + MAX_MATCH_SKIP + 1);
    let found = -1;
    for (let i = cursor; i < limit; i++) {
      if (target[i] === word) {
        found = i;
        break;
      }
    }
    if (found === -1) continue; // filler / misrecognition: the cursor stays
    matched = found;
    cursor = found + 1;
  }
  return clampWordIndex(Math.max(prev, matched), last);
}

/**
 * Map elapsed capture time onto the active-word index of the coach's
 * schedule (feature 121, source A).
 *
 * `wordOnsetsMs[k]` is the ms offset at which word `k` became active in the
 * read (`buildWordStarts`); the active word at `elapsedMs` is the last one
 * whose onset has passed. Elapsed time before the first onset (and onsets
 * that never arrived) position the FIRST word — the capture starts at the
 * beginning of the target. Past the last onset the index caps at the last
 * word and can no longer move.
 *
 * @param {Array<string>} targetTokens - target words, in book order
 * @param {Array<number>|null|undefined} wordOnsetsMs - per-word onset (ms);
 *   `null`/empty means "no schedule" and degrades to `null`
 * @param {unknown} elapsedMs - ms elapsed since the capture was armed (negatives and NaN count as 0)
 * @returns {number|null} the active word index, or null without a schedule
 */
export function timeLiveIndex(targetTokens, wordOnsetsMs, elapsedMs) {
  if (!Array.isArray(wordOnsetsMs) || !wordOnsetsMs.length) return null;
  const last = Math.max(0, (Array.isArray(targetTokens) ? targetTokens.length : 0) - 1);
  const elapsed = Math.max(0, Number(elapsedMs) || 0);
  let active = 0;
  for (let i = 0; i < wordOnsetsMs.length; i++) {
    if (wordOnsetsMs[i] <= elapsed) active = i;
  }
  return clampWordIndex(active, last);
}

/**
 * Rebuild the word schedule of a capture from the coach's clause structure
 * (feature 121): the same `splitForTts` split the read used, with each word
 * onset spread over the nominal cadence and each clause keeping its pause —
 * the user repeating the answer pauses where the coach did, so a pause-aware
 * schedule predicts the position better than a plain linear spread.
 *
 * @param {unknown} target - the full answer being captured
 * @returns {number[]|null} one onset (ms) per target word, or null for a
 *   blank target (nothing to schedule)
 */
export function buildCaptureOnsets(target) {
  const spanCount = tokenizeWords(target).length;
  if (!spanCount) return null;
  const { segments, pausesMs } = splitForTts(target);
  if (!segments.length) return null;
  const totalPause = pausesMs.reduce((a, b) => a + b, 0);
  const durationMs = spanCount * COACH_MS_PER_WORD + totalPause;
  return (
    buildWordStarts(durationMs, segments, pausesMs, spanCount) ??
    Array.from({ length: spanCount }, (_, i) => i * COACH_MS_PER_WORD)
  );
}

/**
 * Build a live position source (feature 121).
 *
 * @param {{
 *   kind: "time" | "interim",
 *   targetTokens: Array<string>,
 *   wordOnsetsMs?: Array<number>|null,
 *   register?: (((handler: (partial: string) => void) => (() => void))|null),
 *   intervalMs?: number,
 *   now?: () => number,
 * }} opts
 *   `kind` — `"time"` schedules off `wordOnsetsMs`; `"interim"` refines off
 *     the STT partials delivered through `register`'s handler.
 *   `targetTokens` - target words in book order (a blank target degrades).
 *   `wordOnsetsMs` - per-word onsets (`buildCaptureOnsets` / `buildWordStarts`);
 *     required by `"time"`, ignored by `"interim"`.
 *   `register` - kind `"interim"` only: subscribes the partial-text handler
 *     and returns the unsubscribe; required, else the source degrades.
 *   `intervalMs` - tick cadence of the `"time"` source.
 *   `now` - injected clock (ms) for the `"time"` source.
 * @returns {LivePositionSource} the source (always non-null: unusable inputs
 *   degrade to a source that emits nothing, never to a throw)
 */
export function createLivePositionSource({
  kind,
  targetTokens,
  wordOnsetsMs = null,
  register = null,
  intervalMs = LIVE_TICK_MS,
  now = () => Date.now(),
}) {
  const tokens = Array.isArray(targetTokens) ? targetTokens : [];
  const onsets = Array.isArray(wordOnsetsMs) ? wordOnsetsMs : [];
  /** @type {((index: number) => void)|null} */
  let listener = null;
  /** Last emitted index; -1 while disarmed. */
  let current = -1;
  let armed = false;
  /** @type {any} setInterval handle (Node Timeout / browser number). */
  let timer = null;
  /** @type {(() => void)|null} */
  let unregister = null;
  let startedAt = 0;

  /** Emit `index` when armed and changed (the monotonic floor is the caller's). */
  const emit = (index) => {
    if (!armed || index === current) return;
    current = index;
    listener?.(index);
  };

  /** Release every resource; keeps the listener so a re-arm just works. */
  const disarm = () => {
    armed = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    unregister?.();
    unregister = null;
  };

  /**
   * (Re)arm the source: reset to the first word, then follow the kind's
   * signal. Unusable inputs return after the reset — a degraded source
   * emits nothing at all, so a capture without a live signal behaves
   * exactly as it did before feature 121.
   */
  function start() {
    disarm();
    current = -1;
    if (!tokens.length) return;
    if (kind === "time") {
      if (!onsets.length) return;
      armed = true;
      startedAt = now();
      emit(timeLiveIndex(tokens, onsets, 0));
      timer = setInterval(() => {
        const index = timeLiveIndex(tokens, onsets, now() - startedAt);
        if (index !== null) emit(index);
      }, intervalMs);
      return;
    }
    if (typeof register !== "function") return;
    armed = true;
    unregister = register((partial) => {
      emit(advanceLiveIndex(Math.max(0, current), tokens, partial));
    });
    emit(0);
  }

  function stop() {
    disarm();
    current = -1;
  }

  function onWord(cb) {
    listener = typeof cb === "function" ? cb : null;
  }

  return { start, stop, onWord };
}
