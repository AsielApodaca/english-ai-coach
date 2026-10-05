/**
 * Session lifecycle routes (features 102/103/105/107).
 *
 * Route contracts (JSDoc blocks moved verbatim from server.ts in feature 117):
 *   POST /api/session/save          — legacy one-shot save (id always server-generated)
 *   POST /api/session/start         — create session + first question
 *   GET  /api/session/:id           — karaoke practice payload
 *   POST /api/session/checkpoint    — persist karaoke progress
 *   POST /api/session/next-question — continuous-session next question
 *
 * The collection endpoints (`/api/sessions…`, `/api/history`) live in
 * `routes/sessions.ts` — see the split note there.
 */

import type { Express } from "express";
import { randomUUID } from "node:crypto";

import { handleSessionStartRequest } from "../session/session-start.ts";
import { handleNextQuestionRequest } from "../practice/continuous.ts";
import { buildSessionPayload } from "../session/session-payload.ts";
import { buildNextStep } from "../practice/learner.ts";
import {
  DEFAULT_ACCENT,
  DEFAULT_SETTINGS_SNAPSHOT,
  fallbackTitle,
  isAttemptWords,
  isLevel,
  isSessionEval,
  isValidSessionId,
  type SessionV2,
} from "../session/storage.ts";
import { candidates } from "./candidate-chain.ts";
import type { AppDeps } from "../app.ts";

/**
 * Whether `fullAnswer` matches the accepted answer shape (feature 117):
 * a string (stored as-is), an object whose optional `text` is a string, or
 * absent/null (empty answer). Numbers, arrays and `{ text: 42 }` are contract
 * violations → the route answers 400 before persisting anything.
 */
function isValidFullAnswer(v: unknown): boolean {
  if (v === undefined || v === null || typeof v === "string") return true;
  if (typeof v !== "object" || Array.isArray(v)) return false;
  const text = (v as Record<string, unknown>).text;
  return text === undefined || typeof text === "string";
}

/**
 * Register the session lifecycle routes.
 *
 * @param app - Express instance under construction (createApp)
 * @param deps - injected dependencies (storage, providers, …)
 */
export function registerSessionRoutes(app: Express, deps: AppDeps): void {
  /**
   * POST /api/session/save — persist a completed practice session as ONE
   * question (legacy endpoint: the current frontend uses /api/session/start +
   * /api/session/checkpoint; this route serves curl/external clients).
   *
   * Body: { id? (IGNORED), category? = "free", level? = "B2",
   *         provider? = "unknown", question? = "", context? = "", fragments?,
   *         fullAnswer? }
   *   The client `id` is ignored — the stored id is ALWAYS a fresh randomUUID
   *   generated server-side, so no client can overwrite an existing session
   *   file (feature 117). question/context must be strings when present and
   *   fullAnswer a string or { text?: string }.
   * 200 → { id, nextStep } — id is the generated session id; nextStep is the
   *   freshly recomputed learner suggestion persisted on the profile.
   * 200 → { id, nextStep: null, warning } when the next-step LLM call fails:
   *   the session is already saved, so the client keeps the id (spec 117 keeps
   *   this degraded success shape unchanged).
   * 400 { error } → question/context/fullAnswer with the wrong type.
   * 500 { error } → the session could not be persisted (e.g. a legacy v1 file).
   */
  app.post("/api/session/save", async (req, res) => {
    const { category = "free", level = "B2", provider = "unknown", question = "", context = "", fragments = [], fullAnswer } =
      req.body ?? {};
    if (typeof question !== "string") return res.status(400).json({ error: "question must be a string." });
    if (typeof context !== "string") return res.status(400).json({ error: "context must be a string." });
    if (!isValidFullAnswer(fullAnswer)) {
      return res.status(400).json({ error: "fullAnswer must be a string or { text?: string }." });
    }
    const now = new Date().toISOString();
    const session: SessionV2 = {
      // Feature 117: always server-generated — a client-supplied id could point
      // at (and overwrite) any existing session file.
      id: randomUUID(),
      status: "completed",
      createdAt: now,
      updatedAt: now,
      config: {
        topicPrompt: String(question || context),
        level: isLevel(level) ? level : "B2",
        category: typeof category === "string" ? category : "free",
        accent: DEFAULT_ACCENT,
        phonemes: [],
        contextFiles: [],
        settingsSnapshot: DEFAULT_SETTINGS_SNAPSHOT,
      },
      provider: typeof provider === "string" ? provider : "unknown",
      title: fallbackTitle(String(question || context)),
      questions: [
        {
          q: String(question),
          answer: String(fullAnswer?.text ?? (typeof fullAnswer === "string" ? fullAnswer : "")),
          fragments: Array.isArray(fragments)
            ? fragments.map((f: { id?: string; text?: string; attempts?: { text: string; score: number }[]; passed?: boolean }) => ({
                id: f.id ?? randomUUID(),
                text: f.text ?? "",
                attempts: Array.isArray(f.attempts)
                  ? f.attempts.map((a) => ({
                      text: a.text ?? "",
                      words: [],
                      score: a.score ?? 0,
                      startedAt: now,
                      durationMs: 0,
                    }))
                  : [],
                passed: Boolean(f.passed),
              }))
            : [],
          fullAttempt: null,
          eval: null,
        },
      ],
    };
    // Persistence inside its own try (feature 117): a legacy v1 file or a disk
    // error must answer 500 { error } — never Express' HTML page, and never the
    // 200 { warning } below (that one is only for the non-fatal next-step LLM).
    try {
      deps.storage.saveSession(session);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
    try {
      const { nextStep } = await buildNextStep(candidates(deps), deps.storage.loadProfile(), deps.storage.loadAllSessions());
      const profile = deps.storage.loadProfile();
      profile.nextStep = nextStep;
      deps.storage.saveProfile(profile);
      res.json({ id: session.id, nextStep });
    } catch (err) {
      res.json({ id: session.id, nextStep: null, warning: (err as Error).message });
    }
  });

  /**
   * POST /api/session/start — create a session and generate its first question
   * (feature 103 / CU1).
   *
   * Body: { topicPrompt, level, contextFiles?: ContextFileRef[], accent?,
   *         focusPhonemes? } — the config snapshot. Rejects with 400 when
   * topicPrompt is empty or level is invalid. Loads learner memory (mandatory),
   * passes the role instruction as system persona, injects the DOCUMENT CONTEXT
   * block when context files are attached, creates the v2 session (feature 102)
   * and persists the first question. Returns { sessionId, firstQuestion }.
   * No session is created until this endpoint is hit (CU3).
   */
  app.post("/api/session/start", async (req, res) => {
    const { status, json } = await handleSessionStartRequest(deps.storage, candidates(deps), req.body);
    res.status(status).json(json);
  });

  /**
   * GET /api/session/:id — karaoke practice data for a session (feature 105).
   *
   * Returns the stored v2 session plus the spoken lines the view needs to run
   * the CU2 flow without importing server-side modules: the full-answer
   * instruction and the pass threshold from the session's settings snapshot
   * (feature 108). The opening speech fields (`intro`, `explainLine`) were
   * removed from this contract by feature 115: the session now starts at the
   * question and the model answer hands over directly to the first fragment.
   * The body itself is built by `buildSessionPayload` (lib/session/session-payload.ts)
   * so the contract is unit-testable without binding a port. The question
   * served is the LAST one — continuous sessions (feature 107) grow
   * questions[]. 404 when the session does not exist.
   */
  app.get("/api/session/:id", (req, res) => {
    const session = deps.storage.loadSession(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found." });
    res.json(buildSessionPayload(session));
  });

  /**
   * POST /api/session/checkpoint — persist karaoke progress (feature 105).
   *
   * Body: { id, status?, fullAttempt?, eval? }. Idempotent saveSession: marks
   * the session completed (or leaves it active), stores the full-answer attempt
   * and its consolidated evaluation on the LAST question (continuous sessions
   * grow questions[], feature 107). Returns { id }.
   *
   * Validation (feature 117): `id` must be a generated session id
   * (/^[a-zA-Z0-9-]+$/), `fullAttempt.words` (when present) an AttemptWord[]
   * of { word, status, startMs?, endMs? } and `eval` (when present) a full
   * SessionEval — anything else is rejected BEFORE anything is persisted.
   * Errors: 400 { error } invalid id/words/eval shape; 404 { error } unknown
   * session; 500 { error } the session file could not be written.
   */
  app.post("/api/session/checkpoint", (req, res) => {
    const { id, status, fullAttempt, eval: evalValue } = req.body ?? {};
    if (typeof id !== "string" || !isValidSessionId(id)) {
      return res.status(400).json({ error: "id is required and must be a session id (letters, digits, dashes)." });
    }
    if (fullAttempt !== undefined && fullAttempt !== null) {
      if (typeof fullAttempt !== "object" || Array.isArray(fullAttempt)) {
        return res.status(400).json({ error: "fullAttempt must be an object." });
      }
      const words = (fullAttempt as Record<string, unknown>).words;
      if (words !== undefined && words !== null && !isAttemptWords(words)) {
        return res
          .status(400)
          .json({ error: "fullAttempt.words must be an array of { word, status, startMs?, endMs? }." });
      }
    }
    if (evalValue !== undefined && evalValue !== null && !isSessionEval(evalValue)) {
      return res.status(400).json({ error: "eval does not match the SessionEval shape." });
    }
    const session = deps.storage.loadSession(id);
    if (!session) return res.status(404).json({ error: "Session not found." });
    if (status === "completed" || status === "active") session.status = status;
    const question = session.questions.at(-1);
    if (question) {
      if (fullAttempt && typeof fullAttempt === "object") {
        question.fullAttempt = {
          text: String(fullAttempt.text ?? ""),
          words: Array.isArray(fullAttempt.words) ? fullAttempt.words : [],
          score: Number(fullAttempt.score ?? 0),
          startedAt: String(fullAttempt.startedAt ?? new Date().toISOString()),
          durationMs: Number(fullAttempt.durationMs ?? 0),
        };
      }
      if (isSessionEval(evalValue)) {
        question.eval = evalValue;
      }
    }
    session.updatedAt = new Date().toISOString();
    // Inside a try (feature 117): a v1 file or disk error answers 500 { error }
    // instead of bubbling to Express' default HTML handler.
    try {
      deps.storage.saveSession(session);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
    res.json({ id: session.id });
  });

  /**
   * POST /api/session/next-question — generate Q_n+1 of a continuous session
   * (feature 107).
   *
   * Body: { sessionId }. The handler computes the adaptive step from the rolling
   * scores (last 3 full-answer evals), generates the next question varying the
   * subtopic (never repeating), applies the adjustment to the session config and
   * persists the new question. Idempotent: when the last question has no eval
   * yet (retry after a network drop) it returns that question without
   * duplicating it. On LLM failure the session stays `active` (502) — the client
   * can retry from the last saved question.
   */
  app.post("/api/session/next-question", async (req, res) => {
    const { status, json } = await handleNextQuestionRequest(deps.storage, candidates(deps), req.body);
    res.status(status).json(json);
  });
}
