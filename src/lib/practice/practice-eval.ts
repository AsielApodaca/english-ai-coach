/**
 * Attempt evaluation (features 001/116) — the deterministic fast path, the
 * LLM refinement and the blend of both.
 *
 * Split out of `practice.ts` by feature 117. `evaluateFragmentDeterministic`
 * answers without an LLM call; `refineWithLLM` adds the coach's issues;
 * `mergeLLMFeedback` blends them (weighted score + verdict + `next`);
 * `evaluateFragment` composes the two for `POST /api/evaluate`.
 */

import type { CompleteOptions } from "../providers/types.ts";
import { chatJSON } from "../providers/index.ts";
import { DEFAULT_PASS_THRESHOLD } from "./karaoke.ts";
import type { FeedbackIssue, Level } from "../session/storage.ts";
import { isFiller, wordMatch } from "./practice-text.ts";
import type { Candidate, Evaluation, WordMatch } from "./practice.ts";

/**
 * Share of the combined score taken from the lexical match (feature 116).
 * Together with {@link NATURALNESS_WEIGHT} it blends the fast deterministic
 * score with the LLM's naturalness — the two must always sum to 1.
 */
export const LEXICAL_WEIGHT = 0.75;

/** Share of the combined score taken from the LLM naturalness (feature 116). */
export const NATURALNESS_WEIGHT = 0.25;

/**
 * Score below which the verdict drops from "almost" to "retry". The PASS
 * boundary is NOT this constant: it is the session's `passThreshold` when the
 * caller can supply one, else {@link DEFAULT_PASS_THRESHOLD} (the single
 * source shared with karaoke.ts).
 */
export const ALMOST_MIN_SCORE = 50;

const SYSTEM_EVALUATE = `You are an experienced English pronunciation/fluency coach for a Spanish-speaking professional.
You receive: the TARGET fragment the user had to repeat, the USER's transcribed speech, the full question context, and the user's level.
Evaluate only what was actually said. Give concise, actionable feedback. Be encouraging but precise.
Respond ONLY with strict JSON (no markdown):
{"issues": [{"category": "grammar|word-choice|fluency|pronunciation|other", "message": string, "fix": string}], "tips": [string], "naturalness": number}
- issues: up to 4 problems found (grammar, wrong word, awkward phrasing, unclear pronunciation, filled pauses).
- message/fix: short and in plain English the learner can understand.
- tips: 1-3 short positive suggestions to improve fluency.
- naturalness: 0-100 how natural the utterance sounds (ignore trivial wording deviations, reward a full complete sentence).
Do not invent errors; if the user's speech is basically correct, return few or zero issues and high naturalness.`;

export interface LLMFeedback {
  issues: FeedbackIssue[];
  tips: string[];
  /**
   * 0-100 naturalness as reported by the model. Absent when the model omitted
   * it: `mergeLLMFeedback` then falls back to the lexical score (feature 116).
   */
  naturalness?: number;
}

/** Result of the LLM-free evaluation of one attempt (feature 116). */
export interface DeterministicEvaluation {
  /** Evaluation built from the lexical match alone (score = lexical score). */
  evaluation: Evaluation;
  /** Raw word match behind it — the input the LLM feedback is merged into. */
  lexical: WordMatch;
}

/**
 * Issues derived from the lexical match (added and missing words), listed
 * before the LLM's own issues. Messages deliberately avoid double quotes:
 * `forcedAmberWordsFromIssues()` (align.ts) reads quoted spans as target words
 * to downgrade, and added words are not target words.
 */
function deriveIssues(lexical: WordMatch): FeedbackIssue[] {
  const derived: FeedbackIssue[] = [];
  const added = lexical.extra.filter((w) => !isFiller(w));
  if (added.length > 0) {
    const listed = added.slice(0, 6).join(", ");
    derived.push({
      category: "other",
      message: `You added words outside the fragment: ${listed}. Repeat only the fragment, word for word.`,
      fix: `Drop the extra words (${listed}) and repeat the fragment exactly as given.`,
    });
  }
  if (lexical.missing.length > 0) {
    derived.push({
      category: "pronunciation",
      message: `Missing word${lexical.missing.length > 1 ? "s" : ""}: "${lexical.missing.join(", ")}". Try to say these clearly.`,
      fix: `Listen again and pronounce: ${lexical.missing.join(", ")}`,
    });
  }
  return derived;
}

/**
 * Merge LLM feedback into the deterministic word match (pure, feature 116):
 * score = {@link LEXICAL_WEIGHT}·lexical + {@link NATURALNESS_WEIGHT}·naturalness
 * (naturalness defaults to the lexical score when absent, so a dead LLM still
 * scores like the fast path), derived issues first then the LLM's own (capped
 * at 5), verdict and `next` from the blended score.
 *
 * @param lexical - deterministic word match the feedback is merged into
 * @param feedback - LLM issues/tips/naturalness (possibly empty)
 * @param opts.passThreshold - score that counts as a pass for `verdict`/`next`;
 *   defaults to {@link DEFAULT_PASS_THRESHOLD} (70). Callers that know the
 *   session's configured threshold (routes/attempt, routes/evaluate) pass it
 *   so pass/fail never diverges from the session settings.
 */
export function mergeLLMFeedback(
  lexical: WordMatch,
  feedback: LLMFeedback,
  opts: { passThreshold?: number } = {},
): Evaluation {
  const passThreshold = opts.passThreshold ?? DEFAULT_PASS_THRESHOLD;
  const naturalness =
    typeof feedback.naturalness === "number" && Number.isFinite(feedback.naturalness)
      ? Math.max(0, Math.min(100, feedback.naturalness))
      : lexical.score;
  const score = Math.round(LEXICAL_WEIGHT * lexical.score + NATURALNESS_WEIGHT * naturalness);
  const issues: FeedbackIssue[] = [...feedback.issues];
  issues.unshift(...deriveIssues(lexical));
  const verdict: Evaluation["verdict"] =
    score >= passThreshold ? "great" : score >= ALMOST_MIN_SCORE ? "almost" : "retry";
  return {
    score,
    verdict,
    matched: lexical.matched,
    missing: lexical.missing,
    extra: lexical.extra,
    issues: issues.slice(0, 5),
    tips: feedback.tips,
    next: score >= passThreshold,
  };
}

/**
 * Deterministic evaluation of an attempt: lexical match + derived issues, NO
 * LLM call (feature 116 — the fast path of `POST /api/attempt`).
 *
 * Its score equals what the composed evaluation yields when the LLM is
 * unavailable (LEXICAL_WEIGHT·L + NATURALNESS_WEIGHT·L = L), so the immediate response and the
 * deterministic fallback of `evaluateFragment` always agree.
 */
export function evaluateFragmentDeterministic(params: {
  target: string;
  userText: string;
  /** Session pass threshold; defaults to `DEFAULT_PASS_THRESHOLD`. */
  passThreshold?: number;
}): DeterministicEvaluation {
  const lexical = wordMatch(params.target, params.userText);
  return {
    lexical,
    evaluation: mergeLLMFeedback(lexical, { issues: [], tips: [] }, { passThreshold: params.passThreshold }),
  };
}

/**
 * LLM refinement of an attempt (feature 116): the exact SYSTEM_EVALUATE
 * context the composed evaluation has always sent (target, user text,
 * question, level). REJECTS when every candidate fails, so callers can tell
 * "no refinement" (→ `refined: false`) from a successful one.
 */
export async function refineWithLLM(
  candidates: Candidate[],
  params: { target: string; userText: string; question: string; level: Level },
): Promise<{ feedback: LLMFeedback; provider: string }> {
  const userPrompt = `TARGET: "${params.target}"\nUSER SAID: "${params.userText}"\nQUESTION: "${params.question}"\nLEVEL: ${params.level}`;
  const options: CompleteOptions = { temperature: 0.3, maxTokens: 4096 };
  const res = await chatJSON<LLMFeedback>(candidates, { system: SYSTEM_EVALUATE, user: userPrompt, options });
  const d = res.data;
  return {
    provider: res.provider,
    feedback: {
      issues: Array.isArray(d.issues) ? d.issues.slice(0, 4) : [],
      tips: Array.isArray(d.tips) ? d.tips.slice(0, 3) : [],
      naturalness: typeof d.naturalness === "number" ? d.naturalness : undefined,
    },
  };
}

/**
 * Composed evaluation (feature 001 contract, still serving `POST /api/evaluate`
 * and its tests): deterministic match refined by the LLM, falling back to the
 * pure deterministic evaluation when every provider fails (feature 116 split —
 * `POST /api/attempt` uses the pieces directly so it can answer without the LLM).
 */
export async function evaluateFragment(
  candidates: Candidate[],
  params: { target: string; userText: string; question: string; level: Level; passThreshold?: number },
): Promise<{ evaluation: Evaluation; provider: string; feedback: LLMFeedback }> {
  const { lexical } = evaluateFragmentDeterministic(params);
  let feedback: LLMFeedback = { issues: [], tips: [], naturalness: lexical.score };
  let provider = "none";
  try {
    const refined = await refineWithLLM(candidates, params);
    provider = refined.provider;
    feedback = { ...refined.feedback, naturalness: refined.feedback.naturalness ?? lexical.score };
  } catch {
    // keep deterministic feedback when LLM is unavailable
  }
  return {
    evaluation: mergeLLMFeedback(lexical, feedback, { passThreshold: params.passThreshold }),
    provider,
    feedback,
  };
}
