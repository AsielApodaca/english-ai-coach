/**
 * Clause splitter for TTS prosody (feature 114) — typed entry point.
 *
 * The implementation lives in `public/speech/prosody.js` because the
 * practice view must run the SAME splitter in the browser (no build step to
 * import TS from `public/`), while the server needs it too for plain `text`
 * requests. This module re-exports it so `src/` and `tests/` have a typed,
 * spec-named entry point and there is only ever ONE implementation.
 *
 * Contract of {@link splitForTts}:
 *   - `segments.length >= 1` for non-empty input (never empty segments),
 *   - `pausesMs.length === segments.length` (silence AFTER each segment),
 *   - short text (≤ 4 words) is not split,
 *   - at most 12 segments per utterance.
 */

import { splitForTts as splitForTtsImpl } from "../../../public/speech/prosody.js";

/** Pause values and limits of the splitter (mirrors the spec ranges). */
export {
  SHORT_PAUSE_MS,
  MEDIUM_PAUSE_MS,
  LONG_PAUSE_MS,
  MAX_SEGMENTS,
  SHORT_TEXT_MAX_WORDS,
} from "../../../public/speech/prosody.js";

/** Result of {@link splitForTts}: clauses plus the silence after each one. */
export interface ProsodySplit {
  /** Non-empty clauses, in order. */
  segments: string[];
  /** Silence appended after each segment (ms); same length as `segments`. */
  pausesMs: number[];
}

/**
 * Split a coach utterance into TTS clauses with measured pauses.
 *
 * @param text - the utterance (question, model answer, fragment, feedback)
 * @returns the segments and the per-segment pauses (see {@link ProsodySplit})
 */
export function splitForTts(text: string): ProsodySplit {
  return splitForTtsImpl(text);
}
