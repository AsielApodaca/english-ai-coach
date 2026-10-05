/**
 * Consolidated attempt + refinement long-poll routes (features 106/116).
 *
 * Route contracts (JSDoc blocks moved verbatim from server.ts in feature 117):
 *   POST /api/attempt              — transcribe + align + persist an attempt
 *   GET  /api/attempt/:id/feedback — long-poll for the LLM refinement
 *
 * Split out of `routes/practice.ts` (feature 117): this pair is the karaoke
 * fast-paint pipeline and would push the practice file past the 300-line
 * module limit.
 */

import express, { type Express } from "express";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { evaluateFragmentDeterministic, isBlankTranscript, isFiller, normalize } from "../practice.ts";
import { checkWhisper, DEFAULT_WHISPER_MODEL, downloadModel, transcribeWords, type WhisperWord } from "../whisper.ts";
import { alignWords, alignTextWords } from "../align.ts";
import { buildFeedbackText, buildNoSpeechText, DEFAULT_PASS_THRESHOLD } from "../cu2.ts";
import { isLevel, isValidOptionalSessionId } from "../session/storage.ts";
import {
  DEFAULT_REFINE_TIMEOUT_MS,
  handleAttemptFeedbackRequest,
  patchFullEval,
  refineAttempt,
} from "../refinement.ts";
import { persistAttempt } from "../session/attempt-persist.ts";
import { clampNumber } from "../tts-status.ts";
import { candidates } from "./chain.ts";
import type { AppDeps } from "../app.ts";

/** Server long-poll cap for `GET /api/attempt/:id/feedback` (env override). */
function refineTimeoutMs(env: NodeJS.ProcessEnv): number {
  return Number(env.REFINE_TIMEOUT_MS ?? DEFAULT_REFINE_TIMEOUT_MS) || DEFAULT_REFINE_TIMEOUT_MS;
}

/**
 * Register the attempt routes.
 *
 * @param app - Express instance under construction (createApp)
 * @param deps - injected dependencies (storage, providers, refinements, …)
 */
export function registerAttemptRoutes(app: Express, deps: AppDeps): void {
  const whisperModel = deps.env.WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL;
  const longPollCapMs = refineTimeoutMs(deps.env);

  /**
   * Consolidated attempt endpoint (feature 106): transcribes the raw recording
   * with word-level timestamps, evaluates it against the target, aligns the
   * spoken words (green/amber/red) and persists the colored attempt. This is the
   * single endpoint the karaoke UI (feature 105) will call.
   *
   * Query params: target (required), question, level (B1|B2|C1), optional
   * sessionId + fragmentId for persistence, full=1 to persist as the question's
   * full answer, mode=text to skip whisper (JSON body { userText } instead of a
   * raw WAV — the karaoke fallback when whisper is unavailable).
   *
   * Response adds `coachLine`: the spoken feedback the coach reads after the
   * attempt (built from the same score/missing/tips the view renders).
   *
   * Feature 116 (fast paint): the LLM does NOT gate this response anymore. The
   * evaluation is deterministic (lexical match + derived issues — no LLM call),
   * `score`/`passed` keep their exact pre-116 values (they were always
   * `align.score`), and `provider` reports `"none"` because no LLM ran yet. The
   * LLM refinement (issues/tips/verdict/coachLine + forced-amber re-alignment)
   * launches BEFORE the response goes out, is registered under the returned
   * `attemptId` and is served by `GET /api/attempt/:id/feedback`.
   * A blank transcript answers exactly as before: no attemptId, no refinement.
   *
   * Validation: 400 { error } for a missing target, an invalid level, or an
   * invalid sessionId/fragmentId (must match /^[a-zA-Z0-9-]+$/ when present —
   * feature 117); 400 when the audio/text payload is missing.
   */
  app.post("/api/attempt", express.raw({ type: "audio/*", limit: "80mb" }), async (req, res) => {
    const buf = req.body as Buffer | undefined;
    const target = typeof req.query.target === "string" ? req.query.target.trim() : "";
    const question = typeof req.query.question === "string" ? req.query.question : "";
    const level = typeof req.query.level === "string" ? req.query.level : "B2";
    const sessionId = typeof req.query.sessionId === "string" ? req.query.sessionId : undefined;
    const fragmentId = typeof req.query.fragmentId === "string" ? req.query.fragmentId : undefined;
    const mode = typeof req.query.mode === "string" ? req.query.mode : "audio";
    const isFull = req.query.full === "1" || req.query.full === "true";
    const passThreshold = clampNumber(req.query.passThreshold, 1, 100, DEFAULT_PASS_THRESHOLD);

    if (!target) return res.status(400).json({ error: "target is required." });
    if (!isLevel(level)) return res.status(400).json({ error: "Invalid level." });
    // Persistence coordinates are untrusted (feature 117): only ids in the
    // storage.sessionFile() format may reach persistAttempt.
    if (!isValidOptionalSessionId(sessionId)) return res.status(400).json({ error: "Invalid sessionId." });
    if (!isValidOptionalSessionId(fragmentId)) return res.status(400).json({ error: "Invalid fragmentId." });

    let text: string;
    let words: WhisperWord[] = [];
    let durationMs = 0;

    if (mode === "text") {
      const body = (req.body ?? {}) as { userText?: unknown };
      if (typeof body.userText !== "string" || body.userText.trim().length === 0) {
        return res.status(400).json({ error: "userText is required in text mode." });
      }
      text = body.userText;
    } else {
      if (!buf || buf.length === 0) return res.status(400).json({ error: "No audio received." });
      const whisper = checkWhisper(whisperModel, deps.rootDir);
      if (!whisper.available) return res.status(400).json({ error: whisper.hint });
      if (!whisper.modelReady) {
        try {
          await downloadModel(whisperModel, deps.rootDir);
        } catch (err) {
          return res.status(500).json({ error: `Model download failed: ${(err as Error).message}` });
        }
        return res.status(400).json({ error: "Model downloaded. Please record again.", code: "MODEL_DOWNLOADED" });
      }

      const tmpDir = join(deps.rootDir, "data", "tmp");
      mkdirSync(tmpDir, { recursive: true });
      const wavPath = join(tmpDir, `attempt-${randomUUID()}.wav`);
      writeFileSync(wavPath, buf);
      try {
        const result = await transcribeWords(wavPath, whisper.modelPath!, deps.rootDir);
        text = result.text;
        words = result.words;
        durationMs = result.durationMs;
      } finally {
        rmSync(wavPath, { force: true });
      }
    }

    // No intelligible speech (silent recording → whisper's [BLANK_AUDIO], or a
    // text attempt with no real words): retry without scoring, LLM feedback or
    // persistence — mirrors the client-side VAD no-speech timeout, so the coach
    // never reports phantom words like "blank_audio".
    if (isBlankTranscript(text)) {
      res.json({
        text: "",
        words: [],
        score: 0,
        matched: [],
        missing: [],
        extra: [],
        addedWords: [],
        issues: [{ category: "other", message: "No speech detected.", fix: "Check your microphone and try again." }],
        verdict: "retry",
        next: false,
        tips: [],
        provider: "none",
        durationMs,
        coachLine: buildNoSpeechText(),
      });
      return;
    }

    try {
      // Feature 116: no LLM on the critical path — lexical match + derived
      // issues + align answer immediately (score/passed unchanged), and the
      // LLM refinement is launched below in background.
      const { evaluation } = evaluateFragmentDeterministic({ target, userText: text, passThreshold });
      // No LLM issues yet → no forced amber on the fast paint; the refinement
      // re-aligns with them (see `refineAttempt`).
      const align = words.length > 0 ? alignWords(words, target) : alignTextWords(text, target);
      const passed = align.score >= passThreshold;
      // Real words said outside the fragment (natural fillers excluded): they
      // lower align.score and are what the coach asks the user to drop. Display
      // form is normalized so "chocolate," reads as "chocolate".
      const addedWords = [...new Set(align.extra.map((w) => normalize(w)).filter((w) => w.length > 0 && !isFiller(w)))];
      // Durability first: the deterministic evaluation is persisted before we
      // respond, exactly like the pre-116 flow.
      persistAttempt(deps.storage, {
        evaluation,
        sessionId,
        fragmentId,
        userText: text,
        target,
        words: align.words,
        score: align.score,
        full: isFull,
        passed,
      });

      // Launch the LLM refinement BEFORE responding: it registers the promise
      // for `GET /api/attempt/:id/feedback` and patches question.eval of a full
      // attempt when it lands. The noop catch keeps an unpolled rejection (LLM
      // down, client gone) from becoming an unhandled rejection.
      const attemptId = randomUUID();
      const pendingRefinement = refineAttempt(candidates(deps), {
        target,
        userText: text,
        question,
        level,
        spokenWords: words,
        passed,
        passThreshold,
        onRefined: (merged) => patchFullEval(deps.storage, sessionId, isFull, merged),
      });
      pendingRefinement.catch(() => {});
      deps.refinements.set(attemptId, pendingRefinement);

      res.json({
        text,
        words: align.words,
        score: align.score,
        matched: align.matched,
        missing: align.missing,
        extra: align.extra,
        addedWords,
        issues: evaluation.issues,
        verdict: evaluation.verdict,
        next: evaluation.next,
        tips: evaluation.tips,
        // No LLM ran yet: the refinement (and its provider) arrives via
        // GET /api/attempt/:id/feedback.
        provider: "none",
        durationMs,
        coachLine: buildFeedbackText({
          score: align.score,
          passed,
          missing: align.missing,
          extra: addedWords,
          tips: evaluation.tips,
        }),
        attemptId,
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * GET /api/attempt/:id/feedback — long-poll for the LLM refinement (116).
   *
   * Waits on the registered promise (bounded by REFINE_TIMEOUT_MS, default 20 s):
   *   resolved → 200 { refined: true, issues, tips, verdict, score, next,
   *                    coachLine, words (re-aligned with forced amber), provider }
   *   LLM down or timeout → 200 { refined: false } — the client keeps the
   *   deterministic state it already painted and speaks the deterministic line.
   *   Unknown/expired id → 404 { error }.
   */
  app.get("/api/attempt/:id/feedback", async (req, res) => {
    const { status, json } = await handleAttemptFeedbackRequest(deps.refinements, req.params.id, longPollCapMs);
    res.status(status).json(json);
  });
}
