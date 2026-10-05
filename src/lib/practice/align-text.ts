/**
 * Text-only alignment (feature 105 fallback without whisper).
 *
 * Same coloring/scoring semantics as `alignWords`, minus the timestamps and
 * the phonetic grading: plain exact-match LCS over normalized tokens. Split
 * out of `align.ts` by feature 117; the shared token types live in
 * `align.ts`.
 */

import { countExtraWords, penalizedScore, tokenize } from "./practice.ts";
import type { NormTargetToken, TargetToken, TextAlignResult, TextAlignedWord } from "./align.ts";

// ---------------------------------------------------------------------------
// Text-only alignment (feature 105 fallback without whisper)
// ---------------------------------------------------------------------------

/**
 * Align a plain (timestamp-less) transcription against a target fragment and
 * color each target word green/red. Used by the karaoke UI when whisper is
 * unavailable (feature 105 fallback): the browser Web Speech API transcribes
 * the user and the server colors the words textually — same matching semantics
 * as feature 001, no timestamps.
 *
 * Coloring per target word: green when every normalized sub-token of the word
 * is matched by the LCS; red otherwise. Spoken tokens with no target position
 * (extras) are returned in `extra` (not rendered on the line). `score` is
 * `penalizedScore(targetWords, greenWords, nonFillerExtras)` — words added
 * outside the fragment subtract from the numerator, so repeating the fragment
 * plus unrelated content cannot score 100.
 */
export function alignTextWords(spokenText: string, target: string): TextAlignResult {
  const rawTarget = target.trim().split(/\s+/).filter(Boolean);
  const targetTokens: TargetToken[] = rawTarget.map((raw) => ({ raw, norm: tokenize(raw) }));
  const targetNorms: NormTargetToken[] = [];
  for (let i = 0; i < targetTokens.length; i++) {
    for (const norm of targetTokens[i].norm) targetNorms.push({ norm, rawIdx: i });
  }
  const spokenNorms = tokenize(spokenText);

  // Plain LCS over normalized tokens (exact matches only — no phonetic grading).
  const n = targetNorms.length;
  const m = spokenNorms.length;
  const width = m + 1;
  const dp = new Uint16Array((n + 1) * width);
  const at = (i: number, j: number) => dp[i * width + j];
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i * width + j] =
        targetNorms[i - 1].norm === spokenNorms[j - 1]
          ? at(i - 1, j - 1) + 1
          : Math.max(at(i - 1, j), at(i, j - 1));
    }
  }
  const matchedNorms = new Set<number>();
  const matchedSpoken = new Set<number>();
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (targetNorms[i - 1].norm === spokenNorms[j - 1]) {
      matchedNorms.add(i - 1);
      matchedSpoken.add(j - 1);
      i--;
      j--;
    } else if (at(i - 1, j) >= at(i, j - 1)) {
      i--;
    } else {
      j--;
    }
  }

  // Reconciliation pass: pair unmatched spoken tokens with unmatched target
  // positions (word-order transpositions). The word was said, just out of
  // place → it stays red but is excluded from both missing and extra (same
  // invariant as alignWords: never missing AND extra at once). Track spoken
  // tokens by INDEX (not by normalized value) so genuine duplicates of an
  // already-consumed word still surface as extra.
  const reconciled = new Array<boolean>(targetNorms.length).fill(false);
  const usedSpoken = new Set<number>(matchedSpoken);
  for (let si = 0; si < spokenNorms.length; si++) {
    if (usedSpoken.has(si)) continue;
    for (let ti = 0; ti < targetNorms.length; ti++) {
      if (matchedNorms.has(ti) || reconciled[ti]) continue;
      if (targetNorms[ti].norm === spokenNorms[si]) {
        reconciled[ti] = true;
        usedSpoken.add(si);
        break;
      }
    }
  }

  const matchedCount = new Array<number>(targetTokens.length).fill(0);
  const anyReconciled = new Array<boolean>(targetTokens.length).fill(false);
  for (let idx = 0; idx < targetNorms.length; idx++) {
    if (matchedNorms.has(idx) || reconciled[idx]) matchedCount[targetNorms[idx].rawIdx]++;
    if (reconciled[idx]) anyReconciled[targetNorms[idx].rawIdx] = true;
  }

  const words: TextAlignedWord[] = targetTokens.map((tt, idx) => ({
    word: tt.raw,
    status:
      tt.norm.length > 0 && matchedCount[idx] === tt.norm.length && !anyReconciled[idx]
        ? "green"
        : "red",
  }));
  // Only fully-matched (green) words count toward the score; partially matched
  // and out-of-place words are red and reported as missing (feedback focus).
  const matched = targetTokens
    .filter((_, idx) => matchedCount[idx] === targetTokens[idx].norm.length && !anyReconciled[idx])
    .map((t) => t.raw);
  const missing = targetTokens
    .filter((_, idx) => matchedCount[idx] < targetTokens[idx].norm.length && !anyReconciled[idx])
    .map((t) => t.raw);
  const extra = spokenNorms.filter((_, idx) => !usedSpoken.has(idx));
  const score = penalizedScore(targetTokens.length, matched.length, countExtraWords(extra));

  return { words, score, matched, missing, extra };
}
