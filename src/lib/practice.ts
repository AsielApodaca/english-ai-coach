import type { CompleteOptions, Provider } from "./providers/types.ts";
import { chatJSON } from "./providers/index.ts";
import { DEFAULT_PASS_THRESHOLD } from "./cu2.ts";
import type { FeedbackIssue, Level } from "./storage.ts";

export type Candidate = Pick<Provider, "id" | "available" | "complete">;

export type Category = "interviews" | "star" | "daily" | "free";
export type { Level };

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
 * source shared with cu2.ts).
 */
export const ALMOST_MIN_SCORE = 50;

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

export const CATEGORY_STAGES: Record<Category, string> = {
  interviews: "Opening, Situation, Task, Action, Result, Closing",
  star: "Situation, Task, Action, Result, Closing",
  daily: "Greeting, Status update, Blockers, Next steps",
  free: "Part 1, Part 2, Part 3, Part 4, Part 5",
};

const SYSTEM_GENERATE = `You are an expert English speaking coach for software engineers, using the call-and-repeat (shadowing) method.
You create interview/practice answers split into short spoken fragments. Each fragment must be a natural, short chunk (5 to 12 words). The complete answer must be 60 to 140 words total.
The user is a Spanish speaker; level tells you the target difficulty (A1 = very simple vocabulary and short sentences, C2 = near-native, rich and technical).
LANGUAGE RULE: every word you output — the question, the fragments and the context — MUST be in English. Never produce Spanish, even if the user's topic/role is described in Spanish.
Use the learner memory block to personalize the answer: reuse words the user struggles with, reference recent topics if useful, and keep difficulty around the user's level.
Respond ONLY with strict JSON matching this schema (no markdown, no commentary):
{"question": string, "context": string, "fragments": [{"id": string, "stage": string, "text": string}]}
- question: the question the coach asks aloud, exactly ONE question, in English.
- context: a short coaching note (what to focus on while repeating this answer), in English.
- fragments: consecutive chunks that assemble into the full spoken answer (the LEARNER's model reply, first person — never the coach's or interviewer's lines), ordered. Use exactly these allowed stages: {stages}.
- id: sequential like "f1", "f2"...`.replace(/\n\s+/g, "\n");

function generatePrompt(category: Category, level: Level, learnerMemory: string, personalized: boolean): { system: string; user: string } {
  const system = SYSTEM_GENERATE.replace("{stages}", CATEGORY_STAGES[category]);
  const memoryLine = learnerMemory ? `\n\nLEARNER MEMORY:\n${learnerMemory}` : "";
  const personalizeLine = personalized
    ? "\nPersonalize the answer to reinforce the user's weak points listed in the learner memory (use those structures/words naturally, don't over-strong them)."
    : "";
  const user = `Generate a practice set. Category: ${category}. Level: ${level}.${memoryLine}${personalizeLine}`;
  return { system, user };
}

export async function generatePracticeSet(
  candidates: Candidate[],
  params: { category: Category; level: Level; learnerMemory: string; personalized?: boolean },
): Promise<{ set: PracticeSet; provider: string }> {
  const { system, user } = generatePrompt(params.category, params.level, params.learnerMemory, params.personalized ?? false);
  const options: CompleteOptions = { temperature: 0.7, maxTokens: 4096 };
  const res = await chatJSON<PracticeSet>(candidates, { system, user, options });
  const fragments = res.data.fragments ?? [];
  return {
    provider: res.provider,
    set: {
      question: res.data.question,
      context: res.data.context,
      fragments: fragments.map((f, i) => ({ id: f.id || `f${i + 1}`, stage: f.stage, text: f.text })),
    },
  };
}

// ---------------------------------------------------------------------------
// First question generation (feature 103 / CU1)
// ---------------------------------------------------------------------------

const SYSTEM_FIRST_QUESTION = `You are an expert English speaking coach for software engineers, using the call-and-repeat (shadowing) method.
The user defines the ROLE you must adopt for this practice session (see ROLE INSTRUCTION below). Adopt that role fully and run the session as that character.
You create the FIRST question of the session plus a model answer split into short spoken fragments. Each fragment must be a natural, short chunk (5 to 12 words). The complete answer must be 60 to 140 words total.
VOICES: the "question" is spoken by the ROLE character; the "fragments" are THE LEARNER's model answer — what a good student/interviewee would reply, in first person (I, my, we). Never put the role character's lines in the fragments: no greetings, no follow-up questions, no thanking or sign-off, no stage directions.
The user is a Spanish speaker; level tells you the target difficulty (A1 = very simple vocabulary and short sentences, C2 = near-native, rich and technical).
LANGUAGE RULE: every word you output — the question, the fragments and the context — MUST be in English. Never produce Spanish, even if the user's topic/role is described in Spanish.
Use the learner memory block to personalize the answer: reuse words the user struggles with, reference recent topics if useful, and keep difficulty around the user's level.
Respond ONLY with strict JSON matching this schema (no markdown, no commentary):
{"question": string, "fragments": [{"id": string, "stage": string, "text": string}]}
- question: exactly ONE question from the role character (1-3 sentences), in English. Not a script: no greetings, no multiple questions, no closing remarks.
- fragments: the learner's own reply to that question, assembled in order, first person, directly answering it. Use exactly these allowed stages: Opening, Main point, Detail, Example, Closing.
- id: sequential like "f1", "f2"...
Example of a valid reply:
{"question":"Tell me about a challenge you overcame in your last project.","fragments":[{"id":"f1","stage":"Opening","text":"In my last project we hit a problem with flaky tests."},{"id":"f2","stage":"Main point","text":"CI failed almost every night for a week."},{"id":"f3","stage":"Detail","text":"I found an outdated fixture that broke the suite."},{"id":"f4","stage":"Example","text":"After the fix, our releases became stable again."},{"id":"f5","stage":"Closing","text":"That lesson taught me to keep test data up to date."}]}`;

/** The first question of a session: the coach's question + the model answer. */
export interface FirstQuestion {
  q: string;
  answer: string;
  fragments: PracticeFragment[];
}

/**
 * Generate the first question of a session from the user's role instruction
 * (feature 103). The role instruction becomes the system persona; the topic
 * prompt, level, learner memory and optional DOCUMENT CONTEXT block drive the
 * generation. The model answer is assembled from the spoken fragments.
 */
export async function generateFirstQuestion(
  candidates: Candidate[],
  params: { topicPrompt: string; level: Level; learnerMemory: string; documentContext?: string },
): Promise<{ question: FirstQuestion; provider: string }> {
  const system = `${SYSTEM_FIRST_QUESTION}\n\nROLE INSTRUCTION:\n${params.topicPrompt}`;
  const memoryLine = params.learnerMemory ? `\n\nLEARNER MEMORY:\n${params.learnerMemory}` : "";
  const docLine = params.documentContext ? `\n\n${params.documentContext}` : "";
  const user = `Generate the first question of the session. Level: ${params.level}.${memoryLine}${docLine}`;
  const options: CompleteOptions = { temperature: 0.7, maxTokens: 4096 };
  const res = await chatJSON<{ question?: unknown; fragments?: Array<{ id?: string; stage?: string; text?: string }> }>(
    candidates,
    { system, user, options },
  );
  const fragments = (res.data.fragments ?? [])
    .map((f, i) => ({ id: f.id || `f${i + 1}`, stage: f.stage ?? "", text: f.text ?? "" }))
    .filter((f) => f.text.trim().length > 0);
  const q = typeof res.data.question === "string" ? res.data.question.trim() : "";
  return {
    provider: res.provider,
    question: {
      q,
      answer: fragments.map((f) => f.text).join(" "),
      fragments,
    },
  };
}

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

const SYSTEM_EVALUATE = `You are an experienced English pronunciation/fluency coach for a Spanish-speaking software engineer.
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