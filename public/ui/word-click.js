/**
 * Karaoke word click → pronunciation (feature 113 / CU2).
 *
 * Pure, DOM-free core of the "tap a word to hear it" interaction: it turns a
 * `pointerdown` + `click` pair into ONE decision — pronounce this token or
 * stay silent — and runs it through the injected effects only.
 *
 * The feature rests on two rules (spec 113):
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
 * Build the delegated word-click controller of the karaoke book (113).
 *
 * Two listeners, one press record:
 *   - `onPointerDown` stores the token + coordinates + timestamp of the press
 *     (only when it landed on a word),
 *   - `onClick` consumes it and decides — gate first, then token match, then
 *     click-vs-drag — and calls `pronounce(token)` at most once.
 *
 * @param {{
 *   isAllowed: () => boolean,
 *   pronounce: (word: string) => void,
 *   dispatch?: (event: { type: string }) => void,
 *   now?: () => number,
 * }} deps
 *   `isAllowed` — the shared word-interaction gate (coach speaking / capture
 *     held → false); consulted inside `onClick`, the second line of defense
 *     after the CSS `data-interactive` flag.
 *   `pronounce` — play the token through the TTS chain. The ONLY side effect.
 *   `dispatch` — state-machine event sink. MUST never be called from here
 *     (the click is isolated from the flow); present so tests can spy on it.
 *   `now` — injected clock (ms) for the click/drag threshold.
 * @returns {{ onPointerDown: (event: object) => void, onClick: (event: object) => string|null }}
 */
export function createWordClickHandler({ isAllowed, pronounce, dispatch = () => {}, now = () => Date.now() }) {
  /** Press in flight: token + origin of the last `pointerdown` on a word. */
  let press = null;

  /** Finite coordinate with a fallback (synthetic events may omit them). */
  const coord = (value, fallback) => (Number.isFinite(value) ? value : fallback);

  /**
   * `pointerdown` on a word → remember where/when the press started.
   * A press anywhere else clears the record, so a later `click` that did not
   * start on a word can never pronounce.
   *
   * @param {{ target?: unknown, clientX?: number, clientY?: number }} event
   */
  function onPointerDown(event) {
    const token = wordTokenOf(event?.target);
    press = token
      ? { token, x: coord(event?.clientX, 0), y: coord(event?.clientY, 0), t: now() }
      : null;
  }

  /**
   * `click` → pronounce the token when the gate allows it, the press belongs
   * to the same word and the gesture is a click (not a drag). Returns the
   * token that was pronounced, or `null` when nothing played.
   *
   * @param {{ target?: unknown, clientX?: number, clientY?: number }} event
   * @returns {string|null} the pronounced token, or null
   */
  function onClick(event) {
    const started = press;
    press = null;
    // Gate INSIDE the handler: programmatic clicks and timing races stop here.
    if (!isAllowed()) return null;
    if (!started) return null; // no pointerdown on a word → not our gesture
    const token = wordTokenOf(event?.target);
    // Released on another word / on an ancestor after a drag → not a click.
    if (!token || token !== started.token) return null;
    const gesture = {
      dx: coord(event?.clientX, started.x) - started.x,
      dy: coord(event?.clientY, started.y) - started.y,
      durationMs: Math.max(0, now() - started.t),
    };
    // Over the threshold → selection: feature 112 owns it, NO audio.
    if (!isClickGesture(gesture)) return null;
    pronounce(token);
    // `dispatch` is deliberately never called: an isolated audio side-effect.
    return token;
  }

  return { onPointerDown, onClick };
}
