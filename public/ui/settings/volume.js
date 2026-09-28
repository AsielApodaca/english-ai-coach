/**
 * Coach volume helpers (feature 108).
 *
 * The volume pref lives in localStorage as `engcoach.volume` (0–100). The UI
 * never lets the user go below `MIN_VOLUME_PCT`: a silent coach is useless in
 * a practice session, so values below the floor — including the legacy `0`
 * written by older builds — are raised to it on read instead of stored.
 *
 * DOM-free on purpose: both the settings slider and the practice view consume
 * these helpers, and the tests import them without a browser.
 */

/** Lowest volume the user may configure (percent). */
export const MIN_VOLUME_PCT = 10;

/** Highest volume the user may configure (percent). */
export const MAX_VOLUME_PCT = 100;

/**
 * Coerce a raw stored value into a usable percentage.
 *
 * @param {unknown} raw - value read from localStorage (number or numeric string)
 * @param {number} [fallback] - returned when `raw` is missing/unparseable
 * @returns {number} integer in [MIN_VOLUME_PCT, MAX_VOLUME_PCT]
 */
export function clampVolumePct(raw, fallback = MAX_VOLUME_PCT) {
  if (raw === null || raw === undefined || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(MAX_VOLUME_PCT, Math.max(MIN_VOLUME_PCT, v));
}

/**
 * Volume as an HTMLMediaElement / SpeechSynthesis factor (0.1–1).
 *
 * @param {unknown} raw - value read from localStorage
 * @param {number} [fallback] - used when `raw` is missing/unparseable
 * @returns {number}
 */
export function volumeFactor(raw, fallback = MAX_VOLUME_PCT) {
  return clampVolumePct(raw, fallback) / 100;
}
