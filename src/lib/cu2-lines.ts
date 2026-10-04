/**
 * Spoken lines and the pass threshold of CU2 (features 105/108/110) — split
 * out of `cu2.ts` by feature 117. These are the strings served to the view
 * through the session endpoints, plus the threshold that decides a pass.
 */

// ---------------------------------------------------------------------------
// Spoken lines (served to the view via the session endpoints)
// ---------------------------------------------------------------------------

/** FULL: coach instructs the user to read the whole answer (CU2 step 14). */
export function buildFullLine(): string {
  return (
    "Great job! Now let's put it all together. Read the entire answer out loud, from start to " +
    "finish. I will highlight each word as you say it."
  );
}

/** Spoken feedback after an attempt (score + focused correction). */
export function buildFeedbackText(outcome: {
  score: number;
  passed: boolean;
  missing: string[];
  /** Words said outside the fragment (natural fillers already removed). */
  extra?: string[];
  tips: string[];
}): string {
  if (outcome.passed) {
    const tip = outcome.tips[0] ? ` ${outcome.tips[0]}` : "";
    return `Great job! That was ${outcome.score} percent accurate.${tip}`;
  }
  const focus: string[] = [];
  if (outcome.missing.length) focus.push(`Focus on: ${outcome.missing.slice(0, 3).join(", ")}`);
  if (outcome.extra?.length) focus.push(`Drop the extra words: ${outcome.extra.slice(0, 3).join(", ")}`);
  const hint = focus.length ? ` ${focus.join(". ")}.` : "";
  return `Almost there. That was ${outcome.score} percent. Let's try that again.${hint}`;
}

/** Spoken feedback when the attempt captured no intelligible speech (silence
 * or whisper's [BLANK_AUDIO]): plain retry, no score talk, no phantom words.
 * Same line the client uses for its VAD no-speech timeout. */
export function buildNoSpeechText(): string {
  return "I didn't hear you. Let's try that again.";
}

/** Default pass threshold when the session/config carries no override. */
export const DEFAULT_PASS_THRESHOLD = 70;

/** Read the pass threshold from a session config snapshot (feature 108). */
export function readPassThreshold(settingsSnapshot?: { overrides?: Record<string, unknown> }): number {
  const value = settingsSnapshot?.overrides?.passThreshold;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_PASS_THRESHOLD;
}
