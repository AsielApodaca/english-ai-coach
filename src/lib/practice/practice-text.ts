/**
 * Text normalization and word-level matching (features 001/105/116).
 *
 * Split out of `practice.ts` by feature 117: everything that turns two
 * strings into comparable tokens and a lexical score. No LLM, no I/O — these
 * are the functions the aligners (align-words, align-text) build on.
 */

/** Normalize text for word-level comparison.
 * Hyphens become separators so "end-to-end" ≡ "end to end" ≡ "end - to - end"
 * (whisper and the LLM disagree on hyphenation), and lone "-" tokens drop out.
 * Bracketed whisper annotations ([BLANK_AUDIO], [MUSIC], …) are not speech
 * and are removed entirely. */
export function normalize(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, " ")
    .toLowerCase()
    .replace(/\bwon't\b/g, "will not")
    .replace(/\bcan't\b/g, "cannot")
    .replace(/\b[a-z]+'ve\b/g, (m) => m.replace("'ve", " have"))
    .replace(/\b[a-z]+'re\b/g, (m) => m.replace("'re", " are"))
    .replace(/\b[a-z]+'ll\b/g, (m) => m.replace("'ll", " will"))
    .replace(/\b[a-z]+'d\b/g, (m) => m.replace("'d", " would"))
    .replace(/\b[a-z]+'m\b/g, (m) => m.replace("'m", " am"))
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  return normalize(text).split(" ").filter(Boolean);
}

/** True when a transcription carries no intelligible speech: empty text or
 * only whisper annotations such as [BLANK_AUDIO] (silence submitted as audio). */
export function isBlankTranscript(text: string): boolean {
  return tokenize(text).length === 0;
}

/** Hesitation/filler tokens that never penalize an attempt score. */
const FILLER_WORDS = new Set(["uh", "uhh", "um", "umm", "er", "erm", "ah", "eh", "hm", "hmm", "mmm", "mhm"]);

/** True when a normalized token is a pure hesitation/filler word. */
export function isFiller(token: string): boolean {
  return FILLER_WORDS.has(token);
}

/** Number of spoken tokens that count against the score (fillers excluded). */
export function countExtraWords(extras: string[]): number {
  return extras.filter((w) => !isFiller(w)).length;
}

/**
 * Score an attempt against its target fragment (0-100).
 *
 * Missing target words and words added outside the fragment both lower the
 * score: every counted extra subtracts one matched word, so merely containing
 * the target never yields 100 (a user padding the fragment with their own
 * content is not a correct repetition). Natural fillers (uh/um/...) are
 * excluded from `extras` by the caller and never penalize.
 *
 * @param targetCount number of words in the target fragment
 * @param matched target words the user actually said
 * @param extras spoken words outside the target (fillers already removed)
 */
export function penalizedScore(targetCount: number, matched: number, extras: number): number {
  if (targetCount === 0) return 0;
  const value = Math.round((100 * (matched - extras)) / targetCount);
  return Math.max(0, Math.min(100, value));
}

export interface WordMatch {
  /** 0-100: (target words said − non-filler added words) over the target length. */
  score: number;
  matched: string[];
  missing: string[];
  extra: string[];
}

/** Longest common subsequence of word tokens (computed naively on token ids). */
export function wordMatch(target: string, user: string): WordMatch {
  const t = tokenize(target);
  const u = tokenize(user);
  const key = (w: string, i: number) => `${w}#${i}`;
  const tIds = t.map(key);
  const uIds = u.map(key);
  const n = t.length;
  const m = u.length;
  const dp: Uint16Array = new Uint16Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => dp[i * (m + 1) + j + 1] ?? 0;
  const set = (i: number, j: number, v: number) => (dp[i * (m + 1) + j + 1] = v);
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      if (t[i - 1] === u[j - 1]) set(i, j, at(i - 1, j - 1) + 1);
      else set(i, j, Math.max(at(i - 1, j), at(i, j - 1)));
    }
  }
  // backtrack to find matched positions (target index + the spoken index it consumed)
  const matchedIdxs: number[] = [];
  const usedSpoken = new Set<number>();
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (t[i - 1] === u[j - 1]) {
      matchedIdxs.push(i - 1);
      usedSpoken.add(j - 1);
      i--;
      j--;
    } else if (at(i - 1, j) >= at(i, j - 1)) {
      i--;
    } else {
      j--;
    }
  }
  const matchedSet = new Set(matchedIdxs);
  const matched = t.filter((_, idx) => matchedSet.has(idx));
  const missing = t.filter((_, idx) => !matchedSet.has(idx));
  // Extras are the spoken tokens the LCS did not consume (by index, so a
  // repeated target word still surfaces as an extra instead of vanishing
  // because its value matches a consumed one).
  const extra = u.filter((_, idx) => !usedSpoken.has(idx));
  const lcs = matched.length;
  return { score: penalizedScore(n, lcs, countExtraWords(extra)), matched, missing, extra };
}
