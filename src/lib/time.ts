/**
 * Time-unit conversion constants (feature 117).
 *
 * Seconds→milliseconds and minutes→milliseconds were written as bare
 * arithmetic across whisper, the refinement registry and the lookup backoff.
 * One module keeps those conversions (and the 60-second TTLs built from them)
 * readable and greppable instead of duplicated as magic numbers.
 */

/** Milliseconds in one second (timestamp math: whisper emits seconds). */
export const MS_PER_S = 1000;

/** Milliseconds in one minute (TTLs and cooldowns of one minute). */
export const MS_PER_MIN = 60 * MS_PER_S;
