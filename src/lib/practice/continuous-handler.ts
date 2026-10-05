/**
 * `POST /api/session/next-question` handler (spec 107) — split out of
 * `continuous.ts` by feature 117 so it can be unit-tested without HTTP or
 * network (same pattern as `handleSessionStartRequest` in session-start.ts).
 *
 * On LLM failure the session stays `active` and the client can retry from the
 * last saved question — nothing is lost (spec 107 NFR).
 */

import { buildLearnerMemory } from "./learner.ts";
import type { Profile, SessionV2 } from "../session/storage.ts";
import {
  DEFAULT_SETTINGS,
  RIGOR_THRESHOLDS,
  readSnapshotSettings,
} from "../settings/settings.ts";
import type { Candidate } from "./practice.ts";
import { computeAdaptive, rollingScores } from "./continuous-adaptive.ts";
import { buildContextSummary, generateNextQuestion } from "./continuous-generate.ts";

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
