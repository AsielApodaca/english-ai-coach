/**
 * Word alignment for the karaoke line (features 001/105/106/116/117).
 *
 * Feature 117 split the 438-line module by alignment mode; this file holds the
 * shared types and recomposes the module, so every existing
 * `from "./align.ts"` import keeps resolving unchanged:
 *
 *   - `align-words.ts` — word-timestamped alignment (`alignWords`, the
 *     weighted-LCS token matcher, the green/amber/red semaphore) plus
 *     `forcedAmberWordsFromIssues` and `levenshtein`.
 *   - `align-text.ts`  — text-only fallback (`alignTextWords`) used when
 *     whisper is unavailable (feature 105).
 */

/** One colored word of the karaoke line (target words + trailing extras). */
export interface AlignedWord {
  word: string;
  status: "green" | "amber" | "red";
  startMs: number;
  endMs: number;
}

/** Result of aligning spoken words against a target fragment. */
export interface AlignResult {
  words: AlignedWord[];
  score: number;
  matched: string[];
  missing: string[];
  extra: string[];
}

/** A raw (display) target word with its normalized sub-tokens. */
export interface TargetToken {
  raw: string;
  norm: string[];
}

/** One normalized target sub-token, pointing back to its display word. */
export interface NormTargetToken {
  norm: string;
  rawIdx: number;
}

/** One normalized spoken token, pointing back to its source WhisperWord. */
export interface SpokenToken {
  token: string;
  wordIdx: number;
}

/** One colored word of a text-only alignment (no timestamps). */
export interface TextAlignedWord {
  word: string;
  status: "green" | "red";
}

/** Result of aligning a plain transcription against a target fragment. */
export interface TextAlignResult {
  words: TextAlignedWord[];
  score: number;
  matched: string[];
  missing: string[];
  extra: string[];
}

export * from "./align-words.ts";
export * from "./align-text.ts";
