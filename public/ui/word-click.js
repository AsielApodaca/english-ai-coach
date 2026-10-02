/**
 * Karaoke word click → pronunciation (feature 113 / CU2).
 *
 * Pure, DOM-free core of the "tap a word to hear it" interaction: it turns a
 * `pointerdown` + `click` pair into ONE decision — pronounce this token (or
 * this selection), or stay silent — and runs it through the injected effects
 * only.
 *
 * The feature rests on three rules (spec 113):
 *
 *   - GATE — the click only acts when `isAllowed()` says so. That is the SAME
 *     gate the lookup popover (112) uses (`canInteractWithWords()` in the
 *     practice view), and it is re-checked INSIDE the handler: neither CSS
 *     `pointer-events`, nor a programmatic click, nor a timing race can
 *     pronounce a word while the coach is reading or a PTT capture is held.
 *   - CLICK vs DRAG — a press that moved beyond `CLICK_MAX_DISTANCE_PX` or
 *     lasted `CLICK_MAX_DURATION_MS` or more is a text selection (feature 112
 *     owns the popover) and must NOT play audio. The thresholds are exported
 *     constants so tests can pin them.
 *   - SELECTION FIRST (precedence) — when the press started inside the word
 *     surface AND the click lands inside it too, an ACTIVE selection wins over
 *     the click-vs-drag threshold: `pronounce(tokens)` plays every selected
 *     token as ONE utterance. WHY precedence is needed: selecting text always
 *     requires dragging well past 5 px/400 ms, so without it a selection
 *     could never be pronounced. An EMPTY selection falls through to the word
 *     path (a plain word click has no selection at all).
 *
 * The handler is a deliberately isolated side-effect: it never routes through
 * the practice state machine — no `TTS_END`, no phase advance, no turn
 * cancel. The `dispatch` sink below is injectable *purely* so tests can spy
 * on it and fail the day anyone couples this path to the reducer; production
 * code never passes it.
 *
 * No module state beyond the press being tracked: the practice view installs
 * these as document-level delegated listeners (they survive `rebuildBook()`),
 * exactly like `lookup-popover.js`.
 */

/** Max pointer movement (px, Euclidean) still counted as a click. */
export const CLICK_MAX_DISTANCE_PX = 5;

/** Max press duration (ms, exclusive) still counted as a click. */
export const CLICK_MAX_DURATION_MS = 400;

/** Selector matching both word surfaces: the span and its wrap (IPA area). */
const WORD_SEL = ".kw, .kw-wrap";

/**
 * Classify a press as a click (`true`) or as a drag/selection (`false`).
 *
 * Movement is measured as the Euclidean distance between `pointerdown` and
 * `click`; the duration is the elapsed time since `pointerdown`. Boundary
 * semantics follow the spec literally: `<= 5 px` AND `< 400 ms`.
 *
 * @param {{ dx?: number, dy?: number, durationMs?: number }} [movement]
 *   `dx`/`dy` — pointer displacement since the press (px)
 *   `durationMs` — time between press and click (ms, clamped at 0)
 * @returns {boolean} true when the gesture is a click (not a selection)
 */
export function isClickGesture({ dx = 0, dy = 0, durationMs = 0 } = {}) {
  const distance = Math.hypot(dx, dy);
  const elapsed = Math.max(0, durationMs);
  return distance <= CLICK_MAX_DISTANCE_PX && elapsed < CLICK_MAX_DURATION_MS;
}

/**
 * Resolve the word token a click target belongs to.
 *
 * Reads `data-word` (the exact token, contractions like `don't` included) and
 * falls back to `textContent` for review-mode spans, which carry no dataset.
 * Both the `.kw` span and its `.kw-wrap` (the IPA annotation area) resolve to
 * the same word; anything else — the lookup popover, the dock, plain lines —
 * resolves to `""`.
 *
 * Deliberately duck-typed (only `closest`/`querySelector`/`dataset`/
 * `textContent` are touched) so tests can drive it with fakes instead of a
 * real DOM.
 *
 * @param {unknown} target - event target
 * @returns {string} the exact token, or "" when the target is not a word
 */
export function wordTokenOf(target) {
  const el = /** @type {{ closest?: Function }|null} */ (target ?? null);
  if (!el || typeof el.closest !== "function") return "";
  const node = /** @type {{ closest: Function, querySelector?: Function, dataset?: object, textContent?: unknown }} */ (
    el.closest(WORD_SEL)
  );
  if (!node) return "";
  // `.kw-wrap` → its word span; `.kw` has no `.kw` descendant, so it stays.
  const kw =
    typeof node.querySelector === "function" ? node.querySelector(".kw") ?? node : node;
  const dataset = kw.dataset;
  const raw =
    dataset && typeof dataset.word === "string" && dataset.word ? dataset.word : kw.textContent;
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Rebuild the selected word tokens from the word spans a selection `Range`
 * covers — the pure core of "click a selection → hear the whole phrase".
 *
 * Deliberate MIRROR of `phraseFromRange` in `lookup-popover.js` with one
 * crucial difference: NO normalization. Nothing is lowercased, no whitespace
 * is collapsed and no edge punctuation is stripped — the tokens feed the TTS
 * and must be spoken exactly as rendered (contractions like `don't` and the
 * original casing like `Shut` are preserved), while the lookup card
 * normalizes only to build its cache key.
 *
 * Every element the range intersects contributes its `data-word` (the exact
 * token; contractions included) and falls back to `textContent` for
 * review-mode spans, which carry no dataset. A drag that starts mid-word
 * therefore still yields whole words, in document order.
 *
 * Deliberately duck-typed (only `intersectsNode`/`dataset`/`textContent` are
 * touched) so tests can drive it with fakes instead of a real DOM.
 *
 * @param {{ intersectsNode(el: object): boolean }} range - the selection range
 * @param {Iterable<object>} elements - candidate word spans in document order
 * @returns {string[]} the exact tokens the range covers, in document order
 */
export function tokensFromRange(range, elements) {
  const tokens = [];
  for (const el of elements) {
    if (!range.intersectsNode(el)) continue;
    const node = /** @type {{ dataset?: { word?: unknown }, textContent?: unknown }} */ (el);
    const raw =
      node.dataset && typeof node.dataset.word === "string" && node.dataset.word
        ? node.dataset.word
        : node.textContent;
    const token = typeof raw === "string" ? raw.trim() : "";
    if (token) tokens.push(token);
  }
  return tokens;
}

/**
 * Build the delegated word-click controller of the karaoke book (113).
 *
 * Two listeners, one press record:
 *   - `onPointerDown` stores the token + scope flag + coordinates + timestamp
 *     of the press (recorded when it landed on a word OR anywhere inside the
 *     word surface, so a selection drag that starts on a line gap counts too),
 *   - `onClick` consumes it and decides — gate first, then SELECTION PATH
 *     (active selection inside the surface, precedence over the threshold),
 *     then the WORD PATH (token match + click-vs-drag) — and calls
 *     `pronounce()` at most once with a `string[]`.
 *
 * @param {{
 *   isAllowed: () => boolean,
 *   pronounce: (words: string[]) => void,
 *   selection?: () => string[],
 *   isScope?: (target: unknown) => boolean,
 *   dispatch?: (event: { type: string }) => void,
 *   now?: () => number,
 * }} deps
 *   `isAllowed` — the shared word-interaction gate (coach speaking / capture
 *     held → false); consulted inside `onClick`, the second line of defense
 *     after the CSS `data-interactive` flag.
 *   `pronounce` — play the token(s) through the TTS chain, ALWAYS as an array:
 *     one token on the word path, every selected token on the selection path.
 *     The ONLY side effect.
 *   `selection` — returns the tokens of the active native selection (scope
 *     already verified by the caller) or `[]` when there is none. Optional;
 *     the default `[]` disables the selection path (word-click-only behavior).
 *   `isScope` — true when an event target sits inside the word surface
 *     (`.karaoke-book` / `.review-words`). Optional; the default `false`
 *     disables the selection path (word-click-only behavior).
 *   `dispatch` — state-machine event sink. MUST never be called from here
 *     (the click is isolated from the flow); present so tests can spy on it.
 *   `now` — injected clock (ms) for the click/drag threshold.
 * @returns {{
 *   onPointerDown: (event: object) => void,
 *   onClick: (event: object) => string[]|null,
 * }}
 */
export function createWordClickHandler({
  isAllowed,
  pronounce,
  selection = () => [],
  isScope = () => false,
  dispatch = () => {},
  now = () => Date.now(),
}) {
  /** Press in flight: the last `pointerdown` that started inside the surface. */
  let press = null;

  /** Finite coordinate with a fallback (synthetic events may omit them). */
  const coord = (value, fallback) => (Number.isFinite(value) ? value : fallback);

  /**
   * `pointerdown` inside the word surface → remember where/when it started.
   *
   * A press counts as in-scope when it landed on a word (a `.kw` always lives
   * inside the book/review surface) OR anywhere else in that surface — a
   * selection drag may start on a line gap or between review words. A press
   * outside both clears the record, so a later `click` that did not start in
   * scope can never pronounce, not even with a selection active.
   *
   * @param {{ target?: unknown, clientX?: number, clientY?: number }} event
   */
  function onPointerDown(event) {
    const token = wordTokenOf(event?.target);
    const inScope = Boolean(token) || Boolean(isScope(event?.target));
    press = inScope
      ? { token, inScope, x: coord(event?.clientX, 0), y: coord(event?.clientY, 0), t: now() }
      : null;
  }

  /**
   * `click` → pronounce when the gate allows it, in this order:
   *
   *   1. GATE — checked first (inside the handler): programmatic clicks and
   *      timing races stop here.
   *   2. SELECTION PATH (precedence) — the press started in scope AND the
   *      click target is in scope AND `selection()` returns ≥ 1 token →
   *      `pronounce(tokens)` plays the whole selection as one utterance and
   *      the click-vs-drag threshold is skipped entirely (a selection drag
   *      ALWAYS exceeds 5 px/400 ms, so applying it would make the selection
   *      unpronounceable). An empty selection (a plain word click) falls
   *      through to the word path.
   *   3. WORD PATH — the target resolves to the SAME token the press started
   *      on and the gesture is within the click-vs-drag threshold →
   *      `pronounce([token])`.
   *
   * @param {{ target?: unknown, clientX?: number, clientY?: number }} event
   * @returns {string[]|null} the pronounced tokens (one on the word path,
   *   every selected token on the selection path), or null when nothing played
   */
  function onClick(event) {
    // Gate INSIDE the handler: programmatic clicks and timing races stop here.
    if (!isAllowed()) return null;
    const started = press;
    press = null;
    if (!started) return null; // no in-scope pointerdown → not our gesture
    // SELECTION PATH — takes precedence over the click-vs-drag threshold.
    if (started.inScope && isScope(event?.target)) {
      const tokens = selection();
      if (tokens.length > 0) {
        pronounce(tokens);
        // `dispatch` is deliberately never called: an isolated audio side-effect.
        return tokens;
      }
    }
    // WORD PATH — released on another word / on an ancestor after a drag →
    // not a click on the pressed word.
    const token = wordTokenOf(event?.target);
    if (!token || token !== started.token) return null;
    const gesture = {
      dx: coord(event?.clientX, started.x) - started.x,
      dy: coord(event?.clientY, started.y) - started.y,
      durationMs: Math.max(0, now() - started.t),
    };
    // Over the threshold → selection: feature 112 owns it, NO audio.
    if (!isClickGesture(gesture)) return null;
    pronounce([token]);
    // `dispatch` is deliberately never called: an isolated audio side-effect.
    return [token];
  }

  return { onPointerDown, onClick };
}
