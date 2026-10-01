/**
 * Push-to-talk (PTT) capture control (feature 111 / CU2).
 *
 * The mic never starts by itself: the view feeds the user's presses into this
 * machine and the machine reports when a capture must start, when it must be
 * cut (→ evaluate the audio) and when it must be discarded (accidental tap).
 * Silence detection (`VadTracker`) no longer decides anything — the turn ends
 * when the user lets go, or at the per-word capture ceiling.
 *
 * Concurrency (spec 111): presses are COUNTED per source (`"pointer"` for the
 * dock button, `"space"` for the keyboard). The capture starts on the 0 → 1
 * transition and cuts on the 1 → 0 transition, so holding the button AND the
 * key records exactly once and only ends when both were released.
 *
 * Pure and testable: every timestamp comes from the injected `now` clock and
 * the ceiling is checked through an explicit `tick()` (the view arms a timer),
 * so no test needs real timers, a DOM or a microphone.
 */

/** Minimum press (ms) below which a capture with no usable audio is dropped. */
export const MIN_PRESS_MS = 200;

/** Capture budget granted per word of the target, in milliseconds. */
export const MS_PER_WORD = 3000;

/**
 * Count the words of a capture target (fragment or full answer).
 *
 * @param {string|null|undefined} text - the target being captured
 * @returns {number} word count (0 for empty/blank/non-string input)
 */
export function countWords(text) {
  if (typeof text !== "string") return 0;
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Capture ceiling for a target: `MS_PER_WORD × wordCount(target)` (spec 111).
 *
 * A fragment of 6 words gets 18 s; a 100-word full answer gets 300 s. The
 * old fixed `MAX_TURN_MS = 60_000` is gone. A blank target keeps one word of
 * budget so it can never collapse into an instant auto-cut.
 *
 * @param {string|null|undefined} text - the target being captured
 * @returns {number} ceiling in milliseconds
 */
export function maxCaptureMs(text) {
  return Math.max(1, countWords(text)) * MS_PER_WORD;
}

/**
 * Gate for the karaoke word interactions (features 112/113), defined here
 * because spec 111 owns the capture state they must respect: words react only
 * when the coach is NOT reading and the user is NOT holding a capture.
 *
 * @param {{ coachSpeaking?: boolean, recording?: boolean }} [state]
 * @returns {boolean} true when hover/click on the book may act
 */
export function wordInteractionAllowed({ coachSpeaking = false, recording = false } = {}) {
  return !coachSpeaking && !recording;
}

/**
 * Push-to-talk state machine for one capture turn.
 *
 * States: `idle` (waiting for the first press) → `recording` (held) → `done`
 * (cut: the audio was handed over for evaluation). An accidental tap returns
 * the machine to `idle`, so the turn keeps waiting without any penalty.
 */
export class PushToTalk {
  /**
   * @param {{
   *   maxCaptureMs?: number,
   *   minPressMs?: number,
   *   now?: () => number,
   *   hasAudio?: () => boolean,
   *   onStart?: () => void,
   *   onCut?: (reason: "release"|"ceiling") => void,
   *   onDiscard?: () => void,
   * }} [opts]
   *   `maxCaptureMs` — ceiling of the capture (ms); `tick()` cuts at it.
   *   `minPressMs` — accidental-tap threshold (ms).
   *   `now` — injected clock (ms, monotonic-ish).
   *   `hasAudio` — whether the active capture buffered usable audio; only
   *     consulted for presses shorter than `minPressMs`.
   *   `onStart` — the capture must begin (first press).
   *   `onCut` — the capture must stop and its audio be evaluated
   *     (`"release"`: all sources let go; `"ceiling"`: time ran out).
   *   `onDiscard` — accidental tap: drop the audio, keep waiting.
   */
  constructor(opts = {}) {
    const {
      maxCaptureMs: ceiling = Infinity,
      minPressMs = MIN_PRESS_MS,
      now = () => Date.now(),
      hasAudio = () => false,
      onStart = null,
      onCut = null,
      onDiscard = null,
    } = opts;

    this.ceilingMs = ceiling;
    this.minPressMs = minPressMs;
    this.now = now;
    this.hasAudio = hasAudio;
    this.onStart = onStart;
    this.onCut = onCut;
    this.onDiscard = onDiscard;

    /** @type {"idle"|"recording"|"done"} */
    this.state = "idle";
    /** Sources currently held down (press counting). */
    this.held = new Set();
    /** Clock reading when the active capture started. */
    this.pressedAt = 0;
  }

  /** True while a capture is being held down. */
  get isRecording() {
    return this.state === "recording";
  }

  /** Number of sources (pointer / space) currently held down. */
  get pressCount() {
    return this.held.size;
  }

  /** True when `source` is currently held down. */
  isHeld(source) {
    return this.held.has(source);
  }

  /**
   * A qualifying press (pointerdown / non-repeat keydown).
   *
   * Starts the capture on the first source; further sources only raise the
   * press count — they can never start a second concurrent capture.
   *
   * @param {string} source - stable id of the trigger (`"pointer"`, `"space"`)
   * @returns {boolean} true when this press started the capture
   */
  press(source) {
    if (this.state === "done" || this.held.has(source)) return false;
    this.held.add(source);
    if (this.state !== "idle") return false; // already recording → no 2nd capture
    this.state = "recording";
    this.pressedAt = this.now();
    this.onStart?.();
    return true;
  }

  /**
   * A release (pointerup / pointercancel / pointerleave / keyup).
   *
   * Cuts the capture only when the LAST source lets go. A press shorter than
   * `minPressMs` that produced no usable audio is discarded instead of
   * evaluated, and the machine goes back to `idle` (the turn keeps waiting).
   *
   * @param {string} source - stable id of the trigger
   * @returns {"cut"|"discard"|null} `null` when this source was not held
   */
  release(source) {
    if (!this.held.delete(source)) return null;
    if (this.state !== "recording" || this.held.size > 0) return null;
    const heldMs = this.now() - this.pressedAt;
    if (heldMs < this.minPressMs && !this.hasAudio()) {
      this.state = "idle";
      this.onDiscard?.();
      return "discard";
    }
    this.state = "done";
    this.onCut?.("release");
    return "cut";
  }

  /**
   * Ceiling check — call it from a timer armed for `maxCaptureMs`.
   *
   * @returns {"ceiling"|null} `"ceiling"` when this tick auto-cut the capture
   */
  tick() {
    if (this.state !== "recording") return null;
    if (this.now() - this.pressedAt < this.ceilingMs) return null;
    this.held.clear();
    this.state = "done";
    this.onCut?.("ceiling");
    return "ceiling";
  }

  /**
   * Abandon the turn (session cancelled / evaluation taken over): no cut and
   * no discard callbacks fire, so the caller discards the audio itself.
   *
   * @returns {boolean} true when a held capture was abandoned
   */
  cancel() {
    if (this.state === "done") return false;
    const wasRecording = this.state === "recording";
    this.held.clear();
    this.state = "done";
    return wasRecording;
  }
}
