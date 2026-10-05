/**
 * Timestamped alignment: spoken WhisperWord[] vs a target fragment.
 *
 * The matcher grades every normalized target sub-token against every
 * normalized spoken token (exact / near / partial) and picks the maximum-weight
 * common subsequence, then paints each target word green / amber / red for the
 * karaoke line. Split out of `align.ts` by feature 117; the shared token types
 * live in `align.ts`.
 */

import { isFiller, normalize, penalizedScore, tokenize } from "./practice.ts";
import type { FeedbackIssue } from "./session/storage.ts";
import type { WhisperWord } from "./whisper.ts";
import type { AlignResult, AlignedWord, NormTargetToken, SpokenToken, TargetToken } from "./align.ts";

/**
 * Levenshtein edit distance between two strings (insert/delete/substitute).
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
  }
  return curr[b.length];
}

/** True when `a` and `b` differ only by swapping two characters. */
function isTransposition(a: string, b: string): boolean {
  if (a.length !== b.length || a.length < 2) return false;
  let first = -1;
  let second = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    if (first === -1) first = i;
    else if (second === -1) second = i;
    else return false;
  }
  return first !== -1 && second !== -1 && a[first] === b[second] && a[second] === b[first];
}

/** True when two words share at least one bigram (loose partial overlap). */
function partialOverlap(a: string, b: string): boolean {
  if (a.length < 2 || b.length < 2) return false;
  const bigrams = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) bigrams.add(a.slice(i, i + 2));
  for (let i = 0; i < b.length - 1; i++) {
    if (bigrams.has(b.slice(i, i + 2))) return true;
  }
  return false;
}

type MatchQuality = "exact" | "near" | "partial" | "none";

/** Grade how well two normalized tokens match each other. */
function matchQuality(a: string, b: string): MatchQuality {
  if (a === b) return "exact";
  if (levenshtein(a, b) <= 1 || isTransposition(a, b)) return "near";
  if (partialOverlap(a, b)) return "partial";
  return "none";
}

/** DP weight for a match quality (exact preferred over near over partial). */
function matchWeight(q: MatchQuality): number {
  return q === "exact" ? 3 : q === "near" ? 2 : q === "partial" ? 1 : 0;
}

/**
 * Maximum-weight common subsequence over normalized tokens.
 *
 * Returns, for each target sub-token, the matched spoken token index (or null)
 * and vice versa, plus the quality of each matched pair. Weighted LCS prefers
 * exact matches over near/partial ones and never claims two spoken tokens for
 * one target position (each position is matched at most once).
 */
function alignTokens(
  targetNorms: NormTargetToken[],
  spokenTokens: SpokenToken[],
): { targetMatch: (number | null)[]; spokenMatch: (number | null)[]; targetQuality: (MatchQuality | null)[] } {
  const n = targetNorms.length;
  const m = spokenTokens.length;
  const width = m + 1;
  const dp = new Array<number>((n + 1) * width).fill(0);
  const at = (i: number, j: number) => dp[i * width + j];
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const w = matchWeight(matchQuality(targetNorms[i - 1].norm, spokenTokens[j - 1].token));
      dp[i * width + j] = Math.max(at(i - 1, j - 1) + w, at(i - 1, j), at(i, j - 1));
    }
  }
  const targetMatch: (number | null)[] = new Array(n).fill(null);
  const spokenMatch: (number | null)[] = new Array(m).fill(null);
  const targetQuality: (MatchQuality | null)[] = new Array(n).fill(null);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const q = matchQuality(targetNorms[i - 1].norm, spokenTokens[j - 1].token);
    const w = matchWeight(q);
    if (w > 0 && at(i, j) === at(i - 1, j - 1) + w) {
      targetMatch[i - 1] = j - 1;
      spokenMatch[j - 1] = i - 1;
      targetQuality[i - 1] = q;
      i--;
      j--;
    } else if (at(i - 1, j) >= at(i, j - 1)) {
      i--;
    } else {
      j--;
    }
  }
  return { targetMatch, spokenMatch, targetQuality };
}

/**
 * Collect words the LLM evaluator flagged so the aligner can downgrade them to
 * amber: quoted words in any issue's fix/message, plus words mentioned in
 * pronunciation issues that are actually part of the target fragment.
 *
 * Moved out of `server.ts` by feature 116 so the forced-amber merge of a
 * refinement is unit-testable next to `alignWords`.
 *
 * @param issues evaluator issues (derived + LLM, when the LLM ran)
 * @param target the fragment the attempt was scored against
 * @returns normalized candidate words for `alignWords({ forcedAmberWords })`
 */
export function forcedAmberWordsFromIssues(issues: FeedbackIssue[], target: string): string[] {
  const targetTokens = new Set(tokenize(target));
  const words = new Set<string>();
  for (const issue of issues) {
    const texts = [issue.fix, issue.message].filter((t): t is string => typeof t === "string" && t.length > 0);
    for (const t of texts) {
      for (const quoted of t.match(/"[^"]+"/g) ?? []) {
        for (const w of tokenize(quoted)) words.add(w);
      }
      if (issue.category === "pronunciation") {
        for (const w of tokenize(t)) {
          if (targetTokens.has(w)) words.add(w);
        }
      }
    }
  }
  return [...words];
}

/**
 * Align spoken (word-timestamped) tokens against a target fragment and color
 * each target word for the karaoke line.
 *
 * Coloring per target word:
 *   - green: every normalized sub-token matched exactly;
 *   - amber: matched but with a near/partial deviation (edit distance ≤ 1,
 *     transposition, shared n-gram), partially matched (e.g. a contraction
 *     half-spoken), or downgraded by `forcedAmberWords`;
 *   - red: not spoken at all (missing).
 *
 * Spoken tokens with no target position (extras, fillers) are appended at the
 * END of `words` as red, keeping their own timestamps. Missing target words
 * inherit the timestamps of the last matched target word before them (0 if
 * none). `score` is `penalizedScore(targetWords, matchedTargetWords, extras)`
 * — matched counts green + amber, and every spoken word that matched nothing
 * subtracts one from the numerator (natural fillers like uh/um never do), so
 * padding the fragment with extra content can no longer score 100.
 *
 * @param spoken word-timestamped transcription of the user's attempt
 * @param target the fragment the user had to repeat
 * @param opts.forcedAmberWords normalized words that, when matched plain, are
 *   downgraded green → amber (used to merge LLM pronunciation feedback)
 */
export function alignWords(
  spoken: WhisperWord[],
  target: string,
  opts?: { forcedAmberWords?: string[] },
): AlignResult {
  const forced = new Set<string>();
  for (const w of opts?.forcedAmberWords ?? []) {
    const n = normalize(w);
    if (n) forced.add(n);
  }

  const rawTarget = target.trim().split(/\s+/).filter(Boolean);
  const targetTokens: TargetToken[] = rawTarget.map((raw) => ({ raw, norm: tokenize(raw) }));
  const targetNorms: NormTargetToken[] = [];
  for (let i = 0; i < targetTokens.length; i++) {
    for (const norm of targetTokens[i].norm) targetNorms.push({ norm, rawIdx: i });
  }

  const spokenTokens: SpokenToken[] = [];
  // Whisper sometimes emits punctuation-only tokens ("." , ","). They yield no
  // normalized tokens, so they are not words at all: they never take part in
  // the alignment (nor render as extras) and must not count as insertions,
  // otherwise a perfect repetition is capped at (n-1)/n by a stray ".".
  const spokenIsWord = new Array<boolean>(spoken.length).fill(false);
  for (let i = 0; i < spoken.length; i++) {
    const tokens = tokenize(spoken[i].word);
    if (tokens.length === 0) continue;
    spokenIsWord[i] = true;
    for (const tok of tokens) spokenTokens.push({ token: tok, wordIdx: i });
  }

  const { targetMatch, spokenMatch, targetQuality } = alignTokens(targetNorms, spokenTokens);

  // Reconciliation pass: pair extras with missing target positions (word-order
  // transpositions). Both sides become amber — the word was said, just out of
  // place. Deterministic: extras are scanned in order, each takes the first
  // unmatched target sub-token it matches.
  const reconciled = new Array<boolean>(targetNorms.length).fill(false);
  for (let si = 0; si < spokenTokens.length; si++) {
    if (spokenMatch[si] !== null) continue;
    for (let ti = 0; ti < targetNorms.length; ti++) {
      if (targetMatch[ti] !== null) continue;
      if (matchQuality(targetNorms[ti].norm, spokenTokens[si].token) !== "none") {
        targetMatch[ti] = si;
        spokenMatch[si] = ti;
        targetQuality[ti] = "near";
        reconciled[ti] = true;
        break;
      }
    }
  }

  const matchedCount = new Array<number>(targetTokens.length).fill(0);
  const anyImperfect = new Array<boolean>(targetTokens.length).fill(false);
  const ts = targetTokens.map(() => ({ startMs: Infinity, endMs: -Infinity }));
  for (let ti = 0; ti < targetNorms.length; ti++) {
    const si = targetMatch[ti];
    if (si === null) continue;
    const rawIdx = targetNorms[ti].rawIdx;
    matchedCount[rawIdx]++;
    if (targetQuality[ti] !== "exact" || reconciled[ti]) anyImperfect[rawIdx] = true;
    const w = spoken[spokenTokens[si].wordIdx];
    ts[rawIdx].startMs = Math.min(ts[rawIdx].startMs, w.startMs);
    ts[rawIdx].endMs = Math.max(ts[rawIdx].endMs, w.endMs);
  }

  const words: AlignedWord[] = [];
  let lastMatchedTs: { startMs: number; endMs: number } | null = null;
  for (let i = 0; i < targetTokens.length; i++) {
    const tt = targetTokens[i];
    const matched = matchedCount[i] > 0;
    let status: AlignedWord["status"];
    if (matched) {
      const allMatched = tt.norm.length > 0 && matchedCount[i] === tt.norm.length;
      status = allMatched && !anyImperfect[i] ? "green" : "amber";
      if (status === "green" && tt.norm.some((n) => forced.has(n))) status = "amber";
      lastMatchedTs = ts[i];
    } else {
      status = "red";
    }
    const t = matched ? ts[i] : (lastMatchedTs ?? { startMs: 0, endMs: 0 });
    words.push({
      word: tt.raw,
      status,
      startMs: Number.isFinite(t.startMs) ? t.startMs : 0,
      endMs: Number.isFinite(t.endMs) ? t.endMs : 0,
    });
  }

  const extra: string[] = [];
  for (let si = 0; si < spokenTokens.length; si++) {
    if (spokenMatch[si] !== null) continue;
    const w = spoken[spokenTokens[si].wordIdx];
    const word = w.word.trim();
    extra.push(word);
    words.push({ word, status: "red", startMs: w.startMs, endMs: w.endMs });
  }

  const matched = targetTokens.filter((_, i) => matchedCount[i] > 0).map((t) => t.raw);
  const missing = targetTokens.filter((_, i) => matchedCount[i] === 0).map((t) => t.raw);
  // Insertions: spoken words that matched no target position at all (a word is
  // matched when ANY of its sub-tokens matched), minus natural fillers and
  // non-word tokens (punctuation) which carry no tokens at all.
  const wordMatched = new Array<boolean>(spoken.length).fill(false);
  for (let si = 0; si < spokenTokens.length; si++) {
    if (spokenMatch[si] !== null) wordMatched[spokenTokens[si].wordIdx] = true;
  }
  let insertions = 0;
  for (let i = 0; i < spoken.length; i++) {
    if (!spokenIsWord[i] || wordMatched[i]) continue;
    if (isFiller(normalize(spoken[i].word))) continue;
    insertions++;
  }
  const score = penalizedScore(targetTokens.length, matched.length, insertions);

  return { words, score, matched, missing, extra };
}
