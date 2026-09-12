import type { CompleteOptions, Provider } from "./providers/types.ts";
import { chatJSON } from "./providers/index.ts";
import type { FeedbackIssue } from "./storage.ts";

export type Candidate = Pick<Provider, "id" | "available" | "complete">;

export type Category = "interviews" | "star" | "daily" | "free";
export type Level = "B1" | "B2" | "C1";

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
The user is a Spanish speaker; level tells you the target difficulty (B1 = simple vocabulary and short sentences, C1 = richer and more technical).
Use the learner memory block to personalize the answer: reuse words the user struggles with, reference recent topics if useful, and keep difficulty around the user's level.
Respond ONLY with strict JSON matching this schema (no markdown, no commentary):
{"question": string, "context": string, "fragments": [{"id": string, "stage": string, "text": string}]}
- question: the question the coach asks aloud.
- context: a short coaching note (what to focus on while repeating this answer).
- fragments: consecutive chunks that assemble into the full spoken answer, ordered. Use exactly these allowed stages: {stages}.
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

/** Normalize text for word-level comparison. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\bwon't\b/g, "will not")
    .replace(/\bcan't\b/g, "cannot")
    .replace(/\b[a-z]+'ve\b/g, (m) => m.replace("'ve", " have"))
    .replace(/\b[a-z]+'re\b/g, (m) => m.replace("'re", " are"))
    .replace(/\b[a-z]+'ll\b/g, (m) => m.replace("'ll", " will"))
    .replace(/\b[a-z]+'d\b/g, (m) => m.replace("'d", " would"))
    .replace(/\b[a-z]+'m\b/g, (m) => m.replace("'m", " am"))
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  return normalize(text).split(" ").filter(Boolean);
}

export interface WordMatch {
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
  // backtrack to find matched positions
  const matchedIdxs: number[] = [];
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    if (t[i - 1] === u[j - 1]) {
      matchedIdxs.push(i - 1);
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
  const used = new Set<string>();
  for (const idx of matchedIdxs) used.add(t[idx]);
  const extra = u.filter((w) => !used.has(w));
  const lcs = matched.length;
  const recall = n === 0 ? 1 : lcs / n;
  const precision = m === 0 ? 0 : lcs / m;
  const fScore = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { score: Math.round(fScore * 100), matched, missing, extra };
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
  naturalness: number;
}

export async function evaluateFragment(
  candidates: Candidate[],
  params: { target: string; userText: string; question: string; level: Level },
): Promise<{ evaluation: Evaluation; provider: string; feedback: LLMFeedback }> {
  const lexical = wordMatch(params.target, params.userText);
  const userPrompt = `TARGET: "${params.target}"\nUSER SAID: "${params.userText}"\nQUESTION: "${params.question}"\nLEVEL: ${params.level}`;
  const options: CompleteOptions = { temperature: 0.3, maxTokens: 4096 };
  let feedback: LLMFeedback = { issues: [], tips: [], naturalness: lexical.score };
  let provider = "none";
  try {
    const res = await chatJSON<LLMFeedback>(candidates, { system: SYSTEM_EVALUATE, user: userPrompt, options });
    provider = res.provider;
    const d = res.data;
    feedback = {
      issues: Array.isArray(d.issues) ? d.issues.slice(0, 4) : [],
      tips: Array.isArray(d.tips) ? d.tips.slice(0, 3) : [],
      naturalness: typeof d.naturalness === "number" ? Math.max(0, Math.min(100, d.naturalness)) : lexical.score,
    };
  } catch {
    // keep deterministic feedback when LLM is unavailable
  }
  const score = Math.round(0.75 * lexical.score + 0.25 * feedback.naturalness);
  const issues: FeedbackIssue[] = [...feedback.issues];
  if (lexical.missing.length > 0) {
    issues.unshift({
      category: "pronunciation",
      message: `Missing word${lexical.missing.length > 1 ? "s" : ""}: "${lexical.missing.join(", ")}". Try to say these clearly.`,
      fix: `Listen again and pronounce: ${lexical.missing.join(", ")}`,
    });
  }
  const verdict: Evaluation["verdict"] = score >= 70 ? "great" : score >= 50 ? "almost" : "retry";
  return {
    provider,
    evaluation: {
      score,
      verdict,
      matched: lexical.matched,
      missing: lexical.missing,
      extra: lexical.extra,
      issues: issues.slice(0, 5),
      tips: feedback.tips,
      next: score >= 70,
    },
    feedback,
  };
}