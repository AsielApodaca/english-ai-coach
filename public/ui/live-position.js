/**
 * Live position of the user's capture (feature 121 / CU2).
 *
 * Pure, DOM-free engine behind the provisional karaoke paint (`kw-live`,
 * `kw-live-spoken`, `kw-live-missing`) and the auto-scroll of the model answer
 * while the mic is held: it answers "which word of the target is the user on
 * right now — and which ones have they already said?" and pushes the answer
 * to the view, which owns every DOM effect.
 *
 * Two interchangeable sources under ONE contract (`LivePositionSource`), both
 * driven by REAL speech (the v1 clock source was rejected in manual testing:
 * a fixed cadence independent of the user's pace is worse than no live paint
 * at all, so "no real-speech signal → no live position" is the degradation):
 *
 *   - `interim` — the live Web Speech transcript (`browser-stt.js` emits
 *     `onInterim`): every rewritten interim is matched against the target.
 *   - `streaming` — cumulative-window partials of the local whisper route
 *     (`POST /api/transcribe-partial`, feature 121 v2): the practice view
 *     paces the windows and feeds their transcript through the same
 *     `register(handler)` funnel.
 *
 * Both kinds share the exact same mechanics — `register(handler)` delivers
 * the partial text and the monotonic greedy matcher refines the position —
 * only the producer of that text differs.
 *
 * Invariants (spec 121):
 *   - MONOTONIC — within one armed source the index only moves forward: STT
 *     partials get rewritten shorter and a matcher may run ahead, and a
 *     rewinding position would make the scroll vibrate.
 *   - CAPPED — the index never leaves `[0, targetTokens.length - 1]`.
 *   - DEGRADES — a source armed without usable data (no register, no target)
 *     emits NOTHING; the capture keeps working exactly as it did before this
 *     feature.
 *
 * `start()` is (re)arm: every push-to-talk press restarts the position at the
 * first word, so an accidental tap discarded by PTT (111) never inherits the
 * position of the tap before it.
 */

import { tokenizeWords } from "./karaoke-color.js";

/**
 * Max target tokens one spoken token may skip when matching forward: absorbs
 * a word the user skipped or that STT missed without letting a stray token
 * jump the position far ahead of what is being said.
 */
export const MAX_MATCH_SKIP = 3;

/**
 * Live position source contract (feature 121). The consumers (`kw-live*`
 * paint + auto-scroll in the practice view) only ever see this shape.
 *
 * @typedef {Object} LivePositionSource
 * @property {() => void} start - (Re)arm: reset the position to the first
 *   word and begin emitting. Safe to call repeatedly — each call restarts.
 * @property {() => void} stop - Stop emitting and release resources (the
 *   `register` subscription). Safe to call twice; nothing emits afterwards.
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
 * Align a spoken partial against the target words (feature 121) — THE single
 * greedy walk of the live layer (`advanceLiveIndex` derives from it).
 *
 * The partial is tokenized with the SAME tokenizer the book renders with
 * (`tokenizeWords`); each spoken token searches the target ahead of the
 * cursor inside a {@link MAX_MATCH_SKIP} window, and a token that matches
 * nothing (filler, misrecognition) is skipped WITHOUT consuming the cursor.
 * The walk is O(partial × window) and deterministic.
 *
 * @param {Array<string>|null|undefined} targetTokens - target words, in book order
 * @param {unknown} spokenPartial - latest STT text (interim or server partial)
 * @returns {{ index: number, spoken: boolean[] }} `index` — active word: the
 *   last target the walk matched (0 when nothing matched, so the paint always
 *   has a valid active word); `spoken[i]` — true only when target word `i`
 *   was matched by the walk (by construction `i > index` is never spoken).
 *   The `spoken` array always has one entry per target word.
 */
export function matchLiveWords(targetTokens, spokenPartial) {
  const tokens = Array.isArray(targetTokens) ? targetTokens : [];
  const last = Math.max(0, tokens.length - 1);
  const spoken = new Array(tokens.length).fill(false);
  const words = tokenizeWords(spokenPartial).map(normalizeToken).filter(Boolean);
  if (!words.length || !tokens.length) return { index: 0, spoken };
  const target = tokens.map(normalizeToken);
  let cursor = 0;
  let matched = -1;
  for (const word of words) {
    const limit = Math.min(target.length, cursor + MAX_MATCH_SKIP + 1);
    let found = -1;
    for (let i = cursor; i < limit; i++) {
      if (target[i] === word) {
        found = i;
        break;
      }
    }
    if (found === -1) continue; // filler / misrecognition: the cursor stays
    spoken[found] = true;
    matched = found;
    cursor = found + 1;
  }
  return { index: clampWordIndex(matched, last), spoken };
}

/**
 * Advance the active-word index against a rewritten STT partial (feature 121).
 *
 * Thin monotonic wrapper over {@link matchLiveWords}: the result never goes
 * backwards — an interim rewritten shorter (Web Speech re-delivers the whole
 * utterance on every result, and a whisper partial may hallucinate less than
 * the previous one) can only keep or raise the index.
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
  const { index } = matchLiveWords(tokens, spokenPartial);
  return Math.max(prev, index);
}

/**
 * Build a live position source (feature 121).
 *
 * @param {{
 *   kind: "interim" | "streaming",
 *   targetTokens: Array<string>,
 *   register?: (((handler: (partial: string) => void) => (() => void))|null),
 * }} opts
 *   `kind` — which producer feeds the handler: `"interim"` (Web Speech, the
 *     recognizer's rewritten utterance) or `"streaming"` (cumulative-window
 *     partials of `/api/transcribe-partial`). Both are equivalent consumers
 *     of `register`'s handler; the kind documents the producer. Any other
 *     value degrades.
 *   `targetTokens` - target words in book order (a blank target degrades).
 *   `register` - subscribes the partial-text handler and returns the
 *     unsubscribe; required, else the source degrades.
 * @returns {LivePositionSource} the source (always non-null: unusable inputs
 *   degrade to a source that emits nothing, never to a throw)
 */
export function createLivePositionSource({ kind, targetTokens, register = null }) {
  const tokens = Array.isArray(targetTokens) ? targetTokens : [];
  const usableKind = kind === "interim" || kind === "streaming";
  /** @type {((index: number) => void)|null} */
  let listener = null;
  /** Last emitted index; -1 while disarmed. */
  let current = -1;
  let armed = false;
  /** @type {(() => void)|null} */
  let unregister = null;

  /** Emit `index` when armed and changed (the monotonic floor is the caller's). */
  const emit = (index) => {
    if (!armed || index === current) return;
    current = index;
    listener?.(index);
  };

  /** Release every resource; keeps the listener so a re-arm just works. */
  const disarm = () => {
    armed = false;
    unregister?.();
    unregister = null;
  };

  /**
   * (Re)arm the source: reset to the first word, then follow the handler's
   * partials. Unusable inputs (unknown kind, no register, no target) return
   * after the reset — a degraded source emits nothing at all, so a capture
   * without a live signal behaves exactly as it did before feature 121.
   */
  function start() {
    disarm();
    current = -1;
    if (!tokens.length || !usableKind || typeof register !== "function") return;
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
