import type { CompleteOptions } from "./providers/types.ts";
import { chatJSON } from "./providers/index.ts";
import type { Candidate } from "./practice.ts";
import type { CategoryStats, NextStep, Profile, Session } from "./storage.ts";

const LEVEL_ORDER = ["A1", "A2", "B1", "B2", "C1", "C2"];

export interface LearnerStats {
  sessions: number;
  avg: number;
  byCategory: Record<string, CategoryStats>;
  weakErrorsTop: [string, number][];
  weakErrors: Record<string, number>;
  vocabGaps: string[];
  trend: number[];
  recentTopics: string[];
}

/** Aggregate all past sessions into a stats snapshot. */
export function computeStats(profile: Profile, sessions: Session[]): LearnerStats {
  const byCategory: Record<string, CategoryStats> = {};
  const weakErrors: Record<string, number> = {};
  const vocabCount: Record<string, number> = {};
  for (const s of sessions) {
    const scores = s.fragments.flatMap((f) => f.attempts.filter((a) => a.verdict !== "retry").map((a) => a.score));
    for (const f of s.fragments) {
      for (const a of f.attempts) {
        for (const iss of a.issues ?? []) weakErrors[iss.category] = (weakErrors[iss.category] ?? 0) + 1;
        const missing = a.missing ?? [];
        const set = new Set(missing.map((w) => w.toLowerCase()));
        for (const w of set) vocabCount[w] = (vocabCount[w] ?? 0) + 1;
      }
    }
    if (scores.length === 0) continue;
    const cat = byCategory[s.category] ?? { sessions: 0, avgScore: 0, trend: [] as number[] };
    cat.sessions += 1;
    cat.trend.push(Math.round(scores.reduce((a, b) => a + b, 0) / scores.length));
    if (cat.trend.length > 20) cat.trend = cat.trend.slice(-20);
  }
  for (const [k, v] of Object.entries(byCategory)) {
    v.avgScore = Math.round(v.trend.reduce((a, b) => a + b, 0) / v.trend.length);
    v.lastScore = v.trend[v.trend.length - 1];
  }
  const weakEntries = Object.entries(weakErrors).sort((a, b) => b[1] - a[1]).slice(0, 6) as [string, number][];
  const vocabGaps = Object.entries(vocabCount)
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([w]) => w);

  const allScores = sessions.flatMap((s) => s.fragments.flatMap((f) => f.attempts.map((a) => a.score)));
  const avg = allScores.length > 0 ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length) : 0;

  const recentTopics = sessionTopics(sessions).slice(0, 8);
  return { sessions: sessions.length, avg, byCategory, weakErrorsTop: weakEntries, trend: [], recentTopics, weakErrors, vocabGaps };
}

export function sessionTopics(sessions: Session[]): string[] {
  return sessions
    .flatMap((s) => (s.context?.length ? [s.question] : []))
    .slice(-10)
    .reverse();
}

export function estimateLevel(profile: Profile, stats: LearnerStats): string {
  const avg = stats.avg;
  const idx = LEVEL_ORDER.indexOf(profile.level || "B2");
  if (avg >= 80) return LEVEL_ORDER[Math.min(5, idx + 1)];
  if (avg < 50) return LEVEL_ORDER[Math.max(0, idx - 1)];
  return profile.level || "B2";
}

/** Compact, prompt-friendly summary of who the learner is right now. */
export function buildLearnerMemory(profile: Profile, sessions: Session[]): string {
  const stats = computeStats(profile, sessions);
  const parts: string[] = [];
  parts.push(`Estimated level: ${profile.level || "B2"}.`);
  parts.push(`Completed sessions: ${stats.sessions}, average score: ${stats.avg}/100.`);
  if (stats.byCategory && Object.keys(stats.byCategory).length > 0) {
    const perCat = Object.entries(stats.byCategory)
      .map(([c, v]) => `${c}: ${v.avgScore} (${v.sessions} sessions)`)
      .join(", ");
    parts.push(`Per-category: ${perCat}.`);
  }
  if (stats.weakErrorsTop.length > 0) {
    parts.push(`Recurring weaknesses: ${stats.weakErrorsTop.map(([e, n]) => `${e} (x${n})`).join(", ")}.`);
  }
  if (profile.recentTopics?.length) {
    parts.push(`Recent topics: ${profile.recentTopics.join(" | ")}.`);
  }
  return parts.join(" ");
}

/** Recompute and persist the profile from all stored sessions. */
export function updateProfile(profile: Profile, sessions: Session[], level?: string): Profile {
  const stats = computeStats(profile, sessions);
  profile.level = level ?? estimateLevel(profile, stats);
  profile.categories = stats.byCategory;
  profile.weakErrors = stats.weakErrors;
  profile.vocabGaps = stats.vocabGaps;
  profile.lastSessionAt = sessions[sessions.length - 1]?.date;
  return profile;
}

const SYSTEM_NEXT_STEP = `You are a learning coach dictating the learner's next move to reach conversational fluency as a software engineer.
Given the learner memory (level, scores, weaknesses, topics), decide ONE concrete next step.
Respond ONLY with strict JSON (no markdown):
{"focus": string, "topic": string, "why": string, "targetLevel": string}
- focus: what skill to train next (e.g. "past-tense narrative fluency", "STAR action verbs", "standup concision").
- topic: a specific practice topic/question to try.
- why: one short sentence linking to the learner's weaknesses.
- targetLevel: the recommended level (A2-B2/C1).`;

export async function buildNextStep(
  candidates: Candidate[],
  profile: Profile,
  sessions: Session[],
): Promise<{ nextStep: NextStep; provider: string }> {
  const memory = buildLearnerMemory(profile, sessions);
  const lastTopic = sessions[sessions.length - 1];
  const user = `Learner memory: ${memory}\nLast session category: ${lastTopic?.category ?? "none"}. Last question: ${lastTopic?.question ?? "none"}.`;
  const options: CompleteOptions = { temperature: 0.5, maxTokens: 4096 };
  try {
    const res = await chatJSON<Omit<NextStep, "generatedAt">>(candidates, { system: SYSTEM_NEXT_STEP, user, options });
    const nextStep: NextStep = { ...res.data, generatedAt: new Date().toISOString() };
    return { nextStep, provider: res.provider };
  } catch {
    const stats = computeStats(profile, sessions);
    const nextStep: NextStep = {
      focus: stats.vocabGaps.length > 0 ? `clear up missing words: ${stats.vocabGaps.join(", ")}` : "keep repeating to build fluency",
      topic: "Another question in the same category until you pass 3 fragments in a row.",
      why: "Generated from your practice history; enable a cloud LLM for richer suggestions.",
      targetLevel: profile.level,
      generatedAt: new Date().toISOString(),
    };
    return { nextStep, provider: "local" };
  }
}