import type { CompleteOptions } from "./providers/types.ts";
import { chatJSON } from "./providers/index.ts";
import type { Candidate } from "./practice.ts";
import { fallbackTitle, LEVELS, type CategoryStats, type Level, type NextStep, type Profile, type SessionV2 } from "./storage.ts";

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

/** Aggregate all past sessions into a stats snapshot (v2 session model). */
export function computeStats(profile: Profile, sessions: SessionV2[]): LearnerStats {
  const byCategory: Record<string, CategoryStats> = {};
  const weakErrors: Record<string, number> = {};
  const vocabCount: Record<string, number> = {};
  for (const s of sessions) {
    const fragments = s.questions.flatMap((q) => q.fragments);
    const attempts = fragments.flatMap((f) => f.attempts);
    const scores = attempts.filter((a) => a.score >= 50).map((a) => a.score);
    for (const a of attempts) {
      for (const w of a.words) {
        if (w.status === "red") {
          const key = w.word.toLowerCase();
          vocabCount[key] = (vocabCount[key] ?? 0) + 1;
        }
      }
    }
    for (const q of s.questions) {
      for (const iss of q.eval?.issues ?? []) {
        weakErrors[iss.category] = (weakErrors[iss.category] ?? 0) + 1;
      }
    }
    if (scores.length === 0) continue;
    const cat = byCategory[s.config.category] ?? { sessions: 0, avgScore: 0, trend: [] as number[] };
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

  const allScores = sessions.flatMap((s) => s.questions.flatMap((q) => q.fragments.flatMap((f) => f.attempts.map((a) => a.score))));
  const avg = allScores.length > 0 ? Math.round(allScores.reduce((a, b) => a + b, 0) / allScores.length) : 0;

  const recentTopics = sessionTopics(sessions).slice(0, 8);
  return { sessions: sessions.length, avg, byCategory, weakErrorsTop: weakEntries, trend: [], recentTopics, weakErrors, vocabGaps };
}

export function sessionTopics(sessions: SessionV2[]): string[] {
  return sessions
    .flatMap((s) => (s.config.topicPrompt?.length ? [s.questions[0]?.q ?? s.config.topicPrompt] : []))
    .slice(-10)
    .reverse();
}

export function estimateLevel(profile: Profile, stats: LearnerStats): Level {
  const avg = stats.avg;
  const idx = LEVELS.indexOf(profile.level);
  const base = idx === -1 ? LEVELS.indexOf("B2") : idx;
  if (avg >= 80) return LEVELS[Math.min(LEVELS.length - 1, base + 1)];
  if (avg < 50) return LEVELS[Math.max(0, base - 1)];
  return LEVELS[base];
}

/** Compact, prompt-friendly summary of who the learner is right now. */
export function buildLearnerMemory(profile: Profile, sessions: SessionV2[]): string {
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
export function updateProfile(profile: Profile, sessions: SessionV2[], level?: Level): Profile {
  const stats = computeStats(profile, sessions);
  profile.level = level ?? estimateLevel(profile, stats);
  profile.categories = stats.byCategory;
  profile.weakErrors = stats.weakErrors;
  profile.vocabGaps = stats.vocabGaps;
  profile.lastSessionAt = sessions.reduce<string | undefined>(
    (acc, s) => (acc === undefined || s.updatedAt > acc ? s.updatedAt : acc),
    undefined,
  );
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

/** The most recently updated session (by updatedAt). */
function mostRecentSession(sessions: SessionV2[]): SessionV2 | undefined {
  return sessions.reduce<SessionV2 | undefined>(
    (acc, s) => (acc === undefined || s.updatedAt > acc.updatedAt ? s : acc),
    undefined,
  );
}

export async function buildNextStep(
  candidates: Candidate[],
  profile: Profile,
  sessions: SessionV2[],
): Promise<{ nextStep: NextStep; provider: string }> {
  const memory = buildLearnerMemory(profile, sessions);
  const lastTopic = mostRecentSession(sessions);
  const user = `Learner memory: ${memory}\nLast session category: ${lastTopic?.config.category ?? "none"}. Last question: ${lastTopic?.questions[0]?.q ?? "none"}.`;
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

const SYSTEM_TITLE = `You are a learning coach. Summarize the user's role instruction for an English speaking practice session into ONE short title line (max 8 words, no quotes, no trailing period).
Respond ONLY with strict JSON (no markdown):
{"title": string}`;

/**
 * Derive a one-line session title from the topic prompt via LLM.
 * Falls back to the first words of the topic prompt when the LLM is
 * unavailable or returns no usable title.
 */
export async function deriveSessionTitle(
  candidates: Candidate[],
  topicPrompt: string,
): Promise<{ title: string; provider: string }> {
  const options: CompleteOptions = { temperature: 0.3, maxTokens: 1024 };
  try {
    const res = await chatJSON<{ title?: unknown }>(candidates, { system: SYSTEM_TITLE, user: topicPrompt, options });
    const title = typeof res.data.title === "string" ? res.data.title.trim() : "";
    if (title) return { title, provider: res.provider };
  } catch {
    // LLM unavailable -> fall back to the first words of the topic prompt
  }
  return { title: fallbackTitle(topicPrompt), provider: "local" };
}