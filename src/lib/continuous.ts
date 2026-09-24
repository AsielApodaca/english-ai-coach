// ---------------------------------------------------------------------------
// Continuous session flow (feature 107) — pure, side-effect free.
//
// Turns the single-question practice (105) into a continuous session
// (Q1 → Q∞): the same v2 session keeps growing its `questions[]` array, one
// question per `next-question` call, until the user finishes the session.
//
// This module owns:
//   - the adaptive difficulty logic (`computeAdaptive`): the average of the
//     last 3 full-answer scores steps the level/rigor up or down, with a
//     human-readable pill message for the UI;
//   - the next-question LLM prompt + generation (`generateNextQuestion`);
//   - the conversation context summary passed to the LLM on every call
//     (`buildContextSummary`);
//   - the `POST /api/session/next-question` handler (`handleNextQuestionRequest`),
//     extracted from the route so it can be unit-tested without HTTP or network
//     (same pattern as `handleSessionStartRequest` in session-start.ts).
//
// On LLM failure the session stays `active` and the client can retry from the
// last saved question — nothing is lost (spec 107 NFR).
// ---------------------------------------------------------------------------

import type { CompleteOptions } from "./providers/types.ts";
import { chatJSON } from "./providers/index.ts";
import type { Candidate, FirstQuestion } from "./practice.ts";
import { buildLearnerMemory } from "./learner.ts";
import { LEVELS, type Level, type Profile, type SessionV2 } from "./storage.ts";
import {
  DEFAULT_SETTINGS,
  RIGOR_LEVELS,
  RIGOR_THRESHOLDS,
  readSnapshotSettings,
  type AdaptiveSettings,
  type RigorLevel,
} from "./settings.ts";

// ---------------------------------------------------------------------------
// Rolling scores (adaptive difficulty)
// ---------------------------------------------------------------------------

/** The last `n` full-answer scores of a session (spec 107: last 3). */
export function rollingScores(session: SessionV2, n = 3): number[] {
  return session.questions
    .map((q) => q.eval?.score)
    .filter((s): s is number => typeof s === "number")
    .slice(-n);
}

/** Arithmetic mean of the rolling scores (0 when empty). */
export function rollingAverage(scores: number[]): number {
  if (scores.length === 0) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/** Result of the adaptive step: the new level/rigor plus the UI pill message. */
export interface AdaptiveResult {
  level: Level;
  rigor: RigorLevel;
  /** Pill message for the UI (e.g. "Dificultad sube a B2 · rigor Estricto"); null when nothing changes. */
  message: string | null;
}

/**
 * Step the difficulty from the rolling scores (spec 107):
 *   - avg(last 3) >= adaptive.up (default 90) → step level AND rigor up;
 *   - avg < adaptive.down (default 65) → step both down;
 *   - otherwise (or with fewer than 3 scores, or adaptive disabled) → no change.
 *
 * Each axis clamps independently (A1–C2 / Flexible–Estricto), so when one axis
 * is already at its max/min the message only mentions the axis that moved.
 * Pure and unit-testable without network.
 */
export function computeAdaptive(
  rolling: number[],
  current: { level: Level; rigor: RigorLevel },
  adaptive: AdaptiveSettings,
): AdaptiveResult {
  const levelIdx = LEVELS.indexOf(current.level);
  const rigorIdx = RIGOR_LEVELS.indexOf(current.rigor);
  if (rolling.length < 3 || !adaptive.enabled || levelIdx === -1 || rigorIdx === -1) {
    return { level: current.level, rigor: current.rigor, message: null };
  }
  const avg = rollingAverage(rolling);
  if (avg >= adaptive.up) {
    const nextLevel = LEVELS[Math.min(LEVELS.length - 1, levelIdx + 1)];
    const nextRigor = RIGOR_LEVELS[Math.min(RIGOR_LEVELS.length - 1, rigorIdx + 1)];
    return { level: nextLevel, rigor: nextRigor, message: adaptiveMessage("up", nextLevel, nextRigor, current) };
  }
  if (avg < adaptive.down) {
    const nextLevel = LEVELS[Math.max(0, levelIdx - 1)];
    const nextRigor = RIGOR_LEVELS[Math.max(0, rigorIdx - 1)];
    return { level: nextLevel, rigor: nextRigor, message: adaptiveMessage("down", nextLevel, nextRigor, current) };
  }
  return { level: current.level, rigor: current.rigor, message: null };
}

/** Build the pill message; null when neither axis actually moved. */
function adaptiveMessage(
  direction: "up" | "down",
  nextLevel: Level,
  nextRigor: RigorLevel,
  current: { level: Level; rigor: RigorLevel },
): string | null {
  const verb = direction === "up" ? "sube" : "baja";
  const levelChanged = nextLevel !== current.level;
  const rigorChanged = nextRigor !== current.rigor;
  if (levelChanged && rigorChanged) {
    // Spec 107 pill: "Dificultad sube a B2 · rigor Estricto"
    return `Dificultad ${verb} a ${nextLevel} · rigor ${nextRigor}`;
  }
  if (levelChanged) return `Dificultad ${verb} a ${nextLevel}`;
  if (rigorChanged) return `Rigor ${verb} a ${nextRigor}`;
  return null;
}

// ---------------------------------------------------------------------------
// Conversation context summary
// ---------------------------------------------------------------------------

/**
 * Compact summary of the ongoing conversation passed to the LLM on every
 * `next-question` call (spec 107): the topic plus the last `maxExchanges`
 * question/answer pairs. The user's side of each exchange is the full-answer
 * attempt when present, otherwise the last fragment attempt.
 */
export function buildContextSummary(session: SessionV2, maxExchanges = 3): string {
  const lines: string[] = [`Topic: ${session.config.topicPrompt}`];
  for (const q of session.questions.slice(-maxExchanges)) {
    const userText =
      q.fullAttempt?.text ?? q.fragments.flatMap((f) => f.attempts).at(-1)?.text ?? "";
    lines.push(`Q: ${q.q}`);
    if (userText) lines.push(`A: ${userText}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Next-question generation
// ---------------------------------------------------------------------------

const SYSTEM_NEXT_QUESTION = `You are an expert English speaking coach for software engineers, using the call-and-repeat (shadowing) method.
The user defines the ROLE you must adopt for this practice session (see ROLE INSTRUCTION below). Adopt that role fully and run the session as that character.
You create the NEXT question of an ongoing practice session plus a model answer split into short spoken fragments. Each fragment must be a natural, short chunk (5 to 12 words). The complete answer must be 60 to 140 words total.
The user is a Spanish speaker; level tells you the target difficulty (A1 = very simple vocabulary and short sentences, C2 = near-native, rich and technical).
The CONVERSATION CONTEXT block lists the topic and the last exchanges. Vary the subtopic within the same topic and do NOT repeat a question already asked.
Use the learner memory block to personalize the answer: reuse words the user struggles with, reference recent topics if useful, and keep difficulty around the user's level.
Respond ONLY with strict JSON matching this schema (no markdown, no commentary):
{"question": string, "fragments": [{"id": string, "stage": string, "text": string}]}
- question: the question the coach asks aloud, in the adopted role.
- fragments: consecutive chunks that assemble into the full spoken model answer, ordered. Use exactly these allowed stages: Opening, Main point, Detail, Example, Closing.
- id: sequential like "f1", "f2"...`;

export interface NextQuestionParams {
  topicPrompt: string;
  level: Level;
  rigor: RigorLevel;
  learnerMemory: string;
  contextSummary: string;
}

/**
 * Generate the next question of a continuous session (spec 107). Mirrors
 * `generateFirstQuestion` (practice.ts): the role instruction becomes the
 * system persona, the conversation context + learner memory drive the prompt,
 * and the model answer is assembled from the spoken fragments.
 */
export async function generateNextQuestion(
  candidates: Candidate[],
  params: NextQuestionParams,
): Promise<{ question: FirstQuestion; provider: string }> {
  const system = `${SYSTEM_NEXT_QUESTION}\n\nROLE INSTRUCTION:\n${params.topicPrompt}`;
  const memoryLine = params.learnerMemory ? `\n\nLEARNER MEMORY:\n${params.learnerMemory}` : "";
  const contextLine = params.contextSummary ? `\n\nCONVERSATION CONTEXT:\n${params.contextSummary}` : "";
  const user = `Generate the next question of the session. Level: ${params.level}. Rigor: ${params.rigor}.${memoryLine}${contextLine}`;
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

// ---------------------------------------------------------------------------
// POST /api/session/next-question handler
// ---------------------------------------------------------------------------

/** Minimal persistence surface the next-question handler needs (storage.ts). */
export interface NextQuestionDeps {
  loadProfile(): Profile;
  loadAllSessions(): SessionV2[];
  loadSession(id: string): SessionV2 | undefined;
  saveSession(session: SessionV2): void;
}

export interface NextQuestionResponse {
  status: number;
  json: Record<string, unknown>;
}

/**
 * Handle a `POST /api/session/next-question` request body and return the HTTP
 * response (spec 107).
 *
 * Validates `sessionId`, requires the session to be `active`, and is idempotent:
 * when the last question has no evaluation yet (a retry after a network drop)
 * it returns that question without generating a duplicate. Otherwise it computes
 * the adaptive step from the rolling scores, generates Q_n+1 (varying the
 * subtopic, never repeating), applies the adjustment to the session config and
 * persists the new question.
 *
 * Returns `{ question, provider, adjustment, level, rigor }` on success;
 * `{ error }` with 400/404/409 for validation or 502 when the LLM generation
 * fails (the session stays `active` — nothing is lost).
 */
export async function handleNextQuestionRequest(
  deps: NextQuestionDeps,
  candidates: Candidate[],
  body: unknown,
): Promise<NextQuestionResponse> {
  const { sessionId } = (body ?? {}) as Record<string, unknown>;
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    return { status: 400, json: { error: "sessionId is required." } };
  }
  const session = deps.loadSession(sessionId);
  if (!session) return { status: 404, json: { error: "Session not found." } };
  if (session.status !== "active") {
    return { status: 409, json: { error: "Session is not active." } };
  }

  const last = session.questions.at(-1);
  // Idempotent retry: the last question was never completed (no eval) — return
  // it as-is so the client restarts the CU2 loop without duplicating it.
  if (last && last.eval === null) {
    return {
      status: 200,
      json: {
        question: { q: last.q, answer: last.answer, fragments: last.fragments },
        idempotent: true,
      },
    };
  }

  const profile = deps.loadProfile();
  const sessions = deps.loadAllSessions();
  const learnerMemory = buildLearnerMemory(profile, sessions);

  // Adaptive difficulty (spec 107): computed from the rolling scores BEFORE the
  // LLM call and applied to the session only when the generation succeeds.
  const settings = readSnapshotSettings(session.config.settingsSnapshot);
  const currentLevel = session.config.level;
  const currentRigor = settings.rigor ?? DEFAULT_SETTINGS.rigor;
  const adaptive = settings.adaptive ?? DEFAULT_SETTINGS.adaptive;
  const adjusted = computeAdaptive(rollingScores(session), { level: currentLevel, rigor: currentRigor }, adaptive);
  const contextSummary = buildContextSummary(session);

  try {
    const { question, provider } = await generateNextQuestion(candidates, {
      topicPrompt: session.config.topicPrompt,
      level: adjusted.level,
      rigor: adjusted.rigor,
      learnerMemory,
      contextSummary,
    });

    // Apply the adaptive adjustment: the session level moves and the snapshot
    // rigor + derived passThreshold follow (spec 107/108).
    session.config.level = adjusted.level;
    if (adjusted.rigor !== currentRigor) {
      session.config.settingsSnapshot.overrides.rigor = adjusted.rigor;
      session.config.settingsSnapshot.overrides.passThreshold = RIGOR_THRESHOLDS[adjusted.rigor];
    }
    session.questions.push({
      q: question.q,
      answer: question.answer,
      // Fragments must carry an attempts array from birth (same convention as
      // session-start.ts): consumers (persistAttempt, computeStats) assume it.
      fragments: question.fragments.map((f) => ({ ...f, attempts: [], passed: false })),
      fullAttempt: null,
      eval: null,
    });
    session.provider = provider;
    deps.saveSession(session);

    return {
      status: 200,
      json: {
        question: { q: question.q, answer: question.answer, fragments: question.fragments },
        provider,
        adjustment: adjusted.message,
        level: adjusted.level,
        rigor: adjusted.rigor,
      },
    };
  } catch (err) {
    // LLM failure: the session stays active and the client can retry from the
    // last saved question (spec 107 NFR — no data is lost).
    return { status: 502, json: { error: (err as Error).message } };
  }
}