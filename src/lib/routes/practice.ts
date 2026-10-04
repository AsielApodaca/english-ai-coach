/**
 * Practice generation + evaluation routes (features 001/103).
 *
 * Route contracts (JSDoc blocks moved verbatim from server.ts in feature 117):
 *   POST /api/practice/new — generate a practice set
 *   POST /api/evaluate     — score a free-text answer
 *   POST /api/next-step    — recompute the learner's next step
 *
 * The attempt pipeline (`/api/attempt` + its long-poll) lives in
 * `routes/attempt.ts` — see the split note there.
 */

import type { Express } from "express";

import { CATEGORY_STAGES, type Category } from "../practice.ts";
import { evaluateFragment, generatePracticeSet } from "../practice.ts";
import { buildLearnerMemory, buildNextStep } from "../learner.ts";
import { readPassThreshold } from "../cu2.ts";
import { isLevel, isValidOptionalSessionId } from "../storage.ts";
import { persistAttempt } from "../attempt-persist.ts";
import { candidates } from "./chain.ts";
import type { AppDeps } from "../app.ts";

function isCategory(v: unknown): v is Category {
  return typeof v === "string" && v in CATEGORY_STAGES;
}

/**
 * Register the practice/evaluation routes.
 *
 * @param app - Express instance under construction (createApp)
 * @param deps - injected dependencies (storage, providers, …)
 */
export function registerPracticeRoutes(app: Express, deps: AppDeps): void {
  /**
   * POST /api/practice/new — generate a fresh practice set (feature 001).
   *
   * Body: { category? = "interviews", level? = "B2", provider?, personalized? = false }
   *   category — key of CATEGORY_STAGES; level — A1..C2; provider — id of the LLM
   *   to prefer (feature 117: unknown ids fall back to the primary provider
   *   instead of reordering the chain); personalized — whether the learner
   *   memory may steer the set.
   * 200 → { set: PracticeSet, provider: ProviderId } — the chosen provider is
   *   echoed so the UI can show which model answered.
   * 400 { error } → invalid category or level (nothing is generated).
   * 502 { error } → every provider in the chain failed (LLM error message).
   * The learner memory (profile + all sessions) is always built and passed in.
   */
  app.post("/api/practice/new", async (req, res) => {
    const { category = "interviews", level = "B2", provider: providerReq, personalized = false } = req.body ?? {};
    if (!isCategory(category) || !isLevel(level)) {
      return res.status(400).json({ error: "Invalid category or level." });
    }
    const profile = deps.storage.loadProfile();
    const sessions = deps.storage.loadAllSessions();
    const learnerMemory = buildLearnerMemory(profile, sessions);
    try {
      const { set, provider } = await generatePracticeSet(candidates(deps, providerReq), {
        category,
        level,
        learnerMemory,
        personalized,
      });
      res.json({ set, provider });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/evaluate — score a free-text answer against a target (feature 001).
   *
   * Body: { target: string, userText: string, question? = "", level? = "B2",
   *         provider?, sessionId?, fragmentId? }
   *   target   — the text to compare against; userText — what the learner said
   *   (both required, userText non-empty); level — A1..C2; provider — preferred
   *   LLM id; sessionId + fragmentId — persistence coordinates (see below).
   * 200 → { evaluation: Evaluation, provider: ProviderId } (deterministic +
   *   LLM-merged evaluation: score, verdict, matched/missing/extra, issues, tips).
   * 400 { error } → missing/empty target|userText, invalid level, or an
   *   invalid sessionId/fragmentId (must be /[a-zA-Z0-9-]+/ — feature 117;
   *   absent still simply disables persistence).
   * 502 { error } → every provider in the chain failed.
   * Side effect: when sessionId names an existing session AND fragmentId names a
   *   fragment of its LAST question, the attempt is appended to that fragment and
   *   the profile is re-aggregated (persistAttempt); otherwise nothing persists.
   */
  app.post("/api/evaluate", async (req, res) => {
    const { target, userText, question, level = "B2", provider: providerReq, sessionId, fragmentId } = req.body ?? {};
    if (typeof target !== "string" || typeof userText !== "string" || userText.trim().length === 0) {
      return res.status(400).json({ error: "target and userText are required." });
    }
    if (!isLevel(level)) return res.status(400).json({ error: "Invalid level." });
    if (!isValidOptionalSessionId(sessionId)) return res.status(400).json({ error: "Invalid sessionId." });
    if (!isValidOptionalSessionId(fragmentId)) return res.status(400).json({ error: "Invalid fragmentId." });
    try {
      // Feature 117: verdict/next follow the SESSION's configured pass
      // threshold when this evaluation belongs to a session; otherwise the
      // documented fallback (DEFAULT_PASS_THRESHOLD) applies inside the merge.
      const sessionIdStr = typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
      const session = sessionIdStr ? deps.storage.loadSession(sessionIdStr) : undefined;
      const passThreshold = session ? readPassThreshold(session.config.settingsSnapshot) : undefined;
      const { evaluation, provider } = await evaluateFragment(candidates(deps, providerReq), {
        target,
        userText,
        question: typeof question === "string" ? question : "",
        level,
        passThreshold,
      });

      persistAttempt(deps.storage, { evaluation, sessionId, fragmentId, userText, target });

      res.json({ evaluation, provider });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });

  /**
   * POST /api/next-step — recompute and persist the learner's next step (103).
   *
   * No body. 200 → { nextStep: string | null } — persisted on the profile
   *   before answering, so GET /api/profile and the sidebar pick it up later.
   * 502 { error } → the LLM call failed; the profile keeps its previous nextStep.
   */
  app.post("/api/next-step", async (_req, res) => {
    try {
      const { nextStep } = await buildNextStep(candidates(deps), deps.storage.loadProfile(), deps.storage.loadAllSessions());
      const profile = deps.storage.loadProfile();
      profile.nextStep = nextStep;
      deps.storage.saveProfile(profile);
      res.json({ nextStep });
    } catch (err) {
      res.status(502).json({ error: (err as Error).message });
    }
  });
}
