/**
 * Practice module (features 001/103/107/116/117).
 *
 * Feature 117 split the 441-line module by responsibility; this file keeps the
 * shared types and recomposes the module, so every existing
 * `from "./practice.ts"` import keeps resolving unchanged:
 *
 *   - practice-generate.ts — the LLM prompts: `generatePracticeSet`,
 *     `generateFirstQuestion` and `CATEGORY_STAGES`.
 *   - practice-text.ts     — `normalize`, `tokenize`, fillers,
 *     `penalizedScore`, `wordMatch` (the lexical layer).
 *   - practice-eval.ts     — `evaluateFragmentDeterministic`,
 *     `refineWithLLM`, `mergeLLMFeedback`, `evaluateFragment` and the
 *     scoring weights (`LEXICAL_WEIGHT`, `NATURALNESS_WEIGHT`,
 *     `ALMOST_MIN_SCORE`).
 */

import type { FeedbackIssue, Level } from "../session/storage.ts";

export type Candidate = Pick<import("../providers/types.ts").Provider, "id" | "available" | "complete">;

export type Category = "interviews" | "star" | "daily" | "free";
export type { Level };

export interface PracticeFragment {
  id: string;
  stage: string;
  text: string;
}

export interface PracticeSet {
  question: string;
  context: string;
  fragments: PracticeFragment[];
}

export interface Evaluation {
  score: number;
  verdict: "great" | "almost" | "retry";
  matched: string[];
  missing: string[];
  extra: string[];
  issues: FeedbackIssue[];
  tips: string[];
  next: boolean;
}

export * from "./practice-generate.ts";
export * from "./practice-text.ts";
export * from "./practice-eval.ts";
