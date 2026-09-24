import express from "express";
import { mkdirSync, writeFileSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { buildProviders, completeWithFallback, providerById, providerStatus } from "./lib/providers/index.ts";
import { type ChatMessage, type ProviderId } from "./lib/providers/types.ts";
import { CATEGORY_STAGES, type Candidate, type Category, type Level } from "./lib/practice.ts";
import { evaluateFragment, generatePracticeSet, tokenize } from "./lib/practice.ts";
import { buildLearnerMemory, buildNextStep, computeStats, updateProfile } from "./lib/learner.ts";
import { checkWhisper, transcribeWav, transcribeWords, downloadModel, type WhisperWord } from "./lib/whisper.ts";
import { alignWords, alignTextWords } from "./lib/align.ts";
import {
  buildExplainLine,
  buildFeedbackText,
  buildFullLine,
  buildIntroText,
  DEFAULT_PASS_THRESHOLD,
  readPassThreshold,
} from "./lib/cu2.ts";
import { handleExtractRequest } from "./lib/extract.ts";
import { handleSessionStartRequest } from "./lib/session-start.ts";
import { handleNextQuestionRequest } from "./lib/continuous.ts";
import { applyProfileSettings, parseProfileSettings, readAutoAdvance, readPrepTime } from "./lib/settings.ts";
import { checkPiper, synthesize as piperSynthesize, synthesizeSegments as piperSynthesizeSegments, SUPPORTED_VOICES } from "./lib/piper.ts";
import { checkEdgeTts, synthesizeEdge, DEFAULT_EDGE_VOICE } from "./lib/edge-tts.ts";
import {
  createStorage,
  DEFAULT_ACCENT,
  DEFAULT_SETTINGS_SNAPSHOT,
  fallbackTitle,
  groupSessionsByRecency,
  isLevel,
  type AttemptWord,
  type FeedbackIssue,
  type Profile,
  type SessionEval,
  type SessionV2,
} from "./lib/storage.ts";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const env = process.env as NodeJS.ProcessEnv;

const providers = buildProviders(env as never);
const primaryProviderId = env.LLM_PROVIDER ?? "cloudflare";
const storage = createStorage(rootDir);
const WHISPER_MODEL = env.WHISPER_MODEL ?? "small.en";

/** Ordered LLM candidates, primary first for fallback. */
function candidates(providerRequested?: string): Candidate[] {
  const primary = (providerRequested ?? primaryProviderId) as ProviderId;
  const viaId = providerById(providers, primary);
  const rest = providers.filter((p) => p.id !== primary);
  return [...(viaId ? [viaId] : []), ...rest];
}

const app = express();
app.use(express.json({ limit: "25mb" }));
app.use(express.static(join(rootDir, "public")));

/** True when the whole stack should stay local (feature 006). */
const OFFLINE_MODE = env.OFFLINE_MODE === "1" || env.OFFLINE_MODE === "true";

function isCategory(v: unknown): v is Category {
  return typeof v === "string" && v in CATEGORY_STAGES;
}

app.get("/api/health", async (_req, res) => {
  const status = await providerStatus(providers);
  const whisper = checkWhisper(WHISPER_MODEL, rootDir);
  res.json({
    ok: true,
    providers: Object.fromEntries(status),
    primary: primaryProviderId,
    notes: {
      zen: "OpenCode Zen free-tier models only work inside the OpenCode app; from custom apps use Gemini or Cloudflare.",
      gemini: "Set GEMINI_API_KEY (free from https://aistudio.google.com/apikey).",
      cloudflare: "Uses CLOUDFLARE_API_TOKEN (+ account id auto-discovered from your opencode config).",
    },
    whisper: {
      available: whisper.available,
      modelReady: whisper.modelReady,
      model: whisper.modelName,
      hint: whisper.hint,
    },
    tts: ttsStatus(),
    dataDir: storage.dataDir,
  });
});

app.post("/api/practice/new", async (req, res) => {
  const { category = "interviews", level = "B2", provider: providerReq, personalized = false } = req.body ?? {};
  if (!isCategory(category) || !isLevel(level)) {
    return res.status(400).json({ error: "Invalid category or level." });
  }
  const profile = storage.loadProfile();
  const sessions = storage.loadAllSessions();
  const learnerMemory = buildLearnerMemory(profile, sessions);
  try {
    const { set, provider } = await generatePracticeSet(candidates(providerReq), {
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

app.post("/api/evaluate", async (req, res) => {
  const { target, userText, question, level = "B2", provider: providerReq, sessionId, fragmentId } = req.body ?? {};
  if (typeof target !== "string" || typeof userText !== "string" || userText.trim().length === 0) {
    return res.status(400).json({ error: "target and userText are required." });
  }
  if (!isLevel(level)) return res.status(400).json({ error: "Invalid level." });
  try {
    const { evaluation, provider } = await evaluateFragment(candidates(providerReq), {
      target,
      userText,
      question: typeof question === "string" ? question : "",
      level,
    });

    persistAttempt({ evaluation, sessionId, fragmentId, userText, target });

    res.json({ evaluation, provider });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

function persistAttempt(params: {
  evaluation: Awaited<ReturnType<typeof evaluateFragment>>["evaluation"];
  sessionId?: string;
  fragmentId?: string;
  userText: string;
  target: string;
  /** Colored word-level alignment (feature 106); empty for text-only attempts. */
  words?: AttemptWord[];
  /** Fragment score override (feature 106: align score, coherent with words). */
  score?: number;
  /** Persist as the question's full answer instead of a fragment (feature 105). */
  full?: boolean;
  /** Pass decision (feature 105: score >= passThreshold); overrides evaluation.next. */
  passed?: boolean;
}): void {
  const { evaluation, sessionId, fragmentId, userText, words = [], score, full = false, passed } = params;
  if (!sessionId) return;
  const session = storage.loadSession(sessionId);
  if (!session) return;
  // Continuous sessions (feature 107) grow `questions[]`; attempts always
  // target the LAST question, never questions[0].
  const question = session.questions.at(-1);
  if (!question) return;
  const passedFlag = passed ?? evaluation.next;
  if (full) {
    question.fullAttempt = {
      text: userText,
      words,
      score: score ?? evaluation.score,
      startedAt: new Date().toISOString(),
      durationMs: 0,
    };
    question.eval = {
      score: evaluation.score,
      verdict: evaluation.verdict,
      matched: evaluation.matched,
      missing: evaluation.missing,
      extra: evaluation.extra,
      issues: evaluation.issues,
      tips: evaluation.tips,
      next: passedFlag,
    };
  } else {
    if (!fragmentId) return;
    const frag = question.fragments.find((f) => f.id === fragmentId);
    if (!frag) return;
    // Fragments created by session-start may lack the attempts array; initialize
    // it defensively so the first attempt never crashes.
    frag.attempts = frag.attempts ?? [];
    frag.attempts.push({
      text: userText,
      words,
      score: score ?? evaluation.score,
      startedAt: new Date().toISOString(),
      durationMs: 0,
    });
    if (passedFlag) frag.passed = true;
  }
  // refresh profile from aggregated data
  const profile = storage.loadProfile();
  const sessions = storage.loadAllSessions();
  updateProfile(profile, sessions);
  const topic = question.q ?? session.config.topicPrompt;
  profile.recentTopics = [topic, ...(profile.recentTopics ?? []).filter((t) => t !== topic)].slice(0, 12);
  storage.saveProfile(profile);
  try {
    storage.saveSession(session);
  } catch {
    // v1 session file: compatibility view — never rewrite it (feature 102)
  }
}

app.post("/api/session/save", async (req, res) => {
  const { id, category = "free", level = "B2", provider = "unknown", question = "", context = "", fragments = [], fullAnswer } =
    req.body ?? {};
  const now = new Date().toISOString();
  const session: SessionV2 = {
    id: typeof id === "string" && id ? id : randomUUID(),
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
  storage.saveSession(session);
  try {
    const { nextStep } = await buildNextStep(candidates(), storage.loadProfile(), storage.loadAllSessions());
    const profile = storage.loadProfile();
    profile.nextStep = nextStep;
    storage.saveProfile(profile);
    res.json({ id: session.id, nextStep });
  } catch (err) {
    res.json({ id: session.id, nextStep: null, warning: (err as Error).message });
  }
});

app.post("/api/next-step", async (_req, res) => {
  try {
    const { nextStep } = await buildNextStep(candidates(), storage.loadProfile(), storage.loadAllSessions());
    const profile = storage.loadProfile();
    profile.nextStep = nextStep;
    storage.saveProfile(profile);
    res.json({ nextStep });
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

/**
 * POST /api/files/extract — extract text from a context file (feature 104).
 *
 * Multipart decision: Express 5 ships no multipart parser and adding one would
 * violate the zero-dependency rule (only pdf-parse + mammoth are allowed), so
 * this endpoint accepts a JSON body with the file content base64-encoded:
 *   { name: string, data: string (base64), sessionId?: string }
 * The frontend reads the dropped file with FileReader.readAsDataURL() and sends
 * the base64 payload. The server decodes, validates extension + size, extracts
 * text (TXT/MD direct, PDF via pdf-parse, DOCX via mammoth), sanitizes it and
 * persists the text under data/tmp/context/<sessionId|draft>/. The original
 * file is never sent anywhere external. Errors are returned as { error }.
 */
app.post("/api/files/extract", async (req, res) => {
  const { status, json } = await handleExtractRequest(storage, req.body);
  res.status(status).json(json);
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
  const { status, json } = await handleSessionStartRequest(storage, candidates(), req.body);
  res.status(status).json(json);
});

/**
 * GET /api/session/:id — karaoke practice data for a session (feature 105).
 *
 * Returns the stored v2 session plus the spoken lines the view needs to run
 * the CU2 flow without importing server-side modules: the intro speech, the
 * fragment-dynamics explanation, the full-answer instruction and the pass
 * threshold from the session's settings snapshot (feature 108). The question
 * served is the LAST one — continuous sessions (feature 107) grow questions[].
 * 404 when the session does not exist.
 */
app.get("/api/session/:id", (req, res) => {
  const session = storage.loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found." });
  const question = session.questions.at(-1);
  res.json({
    session,
    intro: buildIntroText({ topicPrompt: session.config.topicPrompt, level: session.config.level }),
    explainLine: buildExplainLine(),
    fullLine: buildFullLine(),
    passThreshold: readPassThreshold(session.config.settingsSnapshot),
    prepTime: readPrepTime(session.config.settingsSnapshot),
    autoAdvance: readAutoAdvance(session.config.settingsSnapshot),
    question: question
      ? { q: question.q, answer: question.answer, fragments: question.fragments }
      : null,
  });
});

/**
 * POST /api/session/checkpoint — persist karaoke progress (feature 105).
 *
 * Body: { id, status?, fullAttempt?, eval? }. Idempotent saveSession: marks
 * the session completed (or leaves it active), stores the full-answer attempt
 * and its consolidated evaluation on the LAST question (continuous sessions
 * grow questions[], feature 107). Returns { id }.
 */
app.post("/api/session/checkpoint", (req, res) => {
  const { id, status, fullAttempt, eval: evalValue } = req.body ?? {};
  if (typeof id !== "string" || !id) return res.status(400).json({ error: "id is required." });
  const session = storage.loadSession(id);
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
    if (evalValue && typeof evalValue === "object") {
      question.eval = evalValue as SessionEval;
    }
  }
  session.updatedAt = new Date().toISOString();
  storage.saveSession(session);
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
  const { status, json } = await handleNextQuestionRequest(storage, candidates(), req.body);
  res.status(status).json(json);
});

/**
 * GET /api/sessions — session history listing (feature 109).
 *
 * `?group=recency` returns the sidebar payload:
 *   { groups: [{ label: "Today"|"Yesterday"|"Previous 7 Days"|"Older", items: SessionSummary[] }] }
 * grouped by `updatedAt` (local calendar days) with empty groups omitted.
 * Without the query param it returns the flat summary list. Summaries are
 * light: title/level/provider/status/updatedAt/score/progress — never the
 * topicPrompt or question bodies (NFR: cheap listing).
 */
app.get("/api/sessions", (req, res) => {
  const summaries = storage.listSessionSummaries();
  if (req.query.group === "recency") {
    const groups = groupSessionsByRecency(summaries)
      .map((g) => ({ label: g.label, items: g.sessions }))
      .filter((g) => g.items.length > 0);
    return res.json({ groups });
  }
  res.json({ sessions: summaries });
});

/**
 * DELETE /api/sessions/:id — delete a session file (feature 109).
 * Also removes the session's extracted-context bucket. 404 when missing.
 */
app.delete("/api/sessions/:id", (req, res) => {
  const deleted = storage.deleteSession(req.params.id);
  if (!deleted) return res.status(404).json({ error: "Session not found." });
  res.json({ ok: true });
});

/**
 * DELETE /api/sessions — wipe the whole session history (settings "Borrar
 * historial"). Deletes every session file plus its extracted-context bucket.
 * The learner profile is left untouched. Returns { ok, deleted }.
 */
app.delete("/api/sessions", (req, res) => {
  const ids = storage.listSessionSummaries().map((s) => s.id);
  let deleted = 0;
  for (const id of ids) {
    if (storage.deleteSession(id)) deleted++;
  }
  res.json({ ok: true, deleted });
});

/**
 * GET /api/sessions/:id/export — full JSON of a single session (feature 109,
 * low-profile export next to the profile export of 108). 404 when missing.
 */
app.get("/api/sessions/:id/export", (req, res) => {
  const session = storage.loadSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found." });
  res.json(session);
});

app.get("/api/history", (_req, res) => {
  const sessions = storage.loadAllSessions();
  const profile = storage.loadProfile();
  res.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      date: s.updatedAt,
      category: s.config.category,
      level: s.config.level,
      question: s.questions[0]?.q ?? s.title,
      title: s.title,
      status: s.status,
      avgScore: avgSessionScore(s),
      nextStep: profile.nextStep,
    })),
  });
});

app.get("/api/profile", async (_req, res) => {
  const profile = storage.loadProfile();
  const sessions = storage.loadAllSessions();
  const stats = computeStats(profile, sessions);
  res.json({
    profile,
    stats: {
      sessions: stats.sessions,
      avg: stats.avg,
      byCategory: stats.byCategory,
      weakErrorsTop: stats.weakErrorsTop,
      vocabGaps: stats.vocabGaps,
      recentTopics: stats.recentTopics,
      trend: sessions.flatMap((s) => s.questions.flatMap((q) => q.fragments.flatMap((f) => f.attempts.map((a) => a.score)))).slice(-30),
    },
  });
});

/**
 * POST /api/profile/settings — persist the profile-persisted settings
 * (feature 108): rigor, fillers, adaptive, prepTime, provider, personaName,
 * targetLevel, bio, prompt, focusPhonemes. Device prefs stay in localStorage
 * and never reach this endpoint. Idempotent: missing fields keep their
 * previous profile values. Returns the updated profile.
 */
app.post("/api/profile/settings", (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const parsed = parseProfileSettings(body);
  const profile = storage.loadProfile();
  const updated = applyProfileSettings(profile, parsed);
  storage.saveProfile(updated);
  res.json({ profile: updated });
});

/**
 * GET /api/storage — local storage usage report (feature 108 settings panel):
 * profile size, session count and total bytes under `data/`.
 */
app.get("/api/storage", (_req, res) => {
  let sessionsCount = 0;
  let sessionsBytes = 0;
  try {
    for (const f of readdirSync(storage.sessionsDir)) {
      if (!f.endsWith(".json")) continue;
      sessionsCount++;
      sessionsBytes += statSync(join(storage.sessionsDir, f)).size;
    }
  } catch {
    // sessions dir may not exist yet — report zeros
  }
  let profileBytes = 0;
  try {
    profileBytes = statSync(storage.profilePath).size;
  } catch {
    // no profile yet
  }
  res.json({
    dataDir: storage.dataDir,
    profileBytes,
    sessionsCount,
    sessionsBytes,
    totalBytes: profileBytes + sessionsBytes,
  });
});

/**
 * GET /api/export — full local data export (feature 108): profile + all
 * sessions as JSON, stamped with the export time.
 */
app.get("/api/export", (_req, res) => {
  res.json({
    exportedAt: new Date().toISOString(),
    profile: storage.loadProfile(),
    sessions: storage.loadAllSessions(),
  });
});

app.post("/api/transcribe", express.raw({ type: "audio/*", limit: "80mb" }), async (req, res) => {
  const buf = req.body as Buffer | undefined;
  if (!buf || buf.length === 0) return res.status(400).json({ error: "No audio received." });
  const whisper = checkWhisper(WHISPER_MODEL, rootDir);
  if (!whisper.available) return res.status(400).json({ error: whisper.hint });
  if (!whisper.modelReady) {
    try {
      await downloadModel(WHISPER_MODEL, rootDir);
    } catch (err) {
      return res.status(500).json({ error: `Model download failed: ${(err as Error).message}` });
    }
    return res.status(400).json({ error: "Model downloaded. Please record again.", code: "MODEL_DOWNLOADED" });
  }
  const tmpDir = join(rootDir, "data", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const wavPath = join(tmpDir, `rec-${randomUUID()}.wav`);
  writeFileSync(wavPath, buf);
  const withWords = req.query.words === "1" || req.query.words === "true";
  try {
    if (withWords) {
      const result = await transcribeWords(wavPath, whisper.modelPath!, rootDir);
      res.json({ text: result.text, words: result.words, durationMs: result.durationMs });
    } else {
      const result = await transcribeWav(wavPath, whisper.modelPath!, rootDir);
      res.json({ text: result.text, durationMs: result.durationMs });
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  } finally {
    rmSync(wavPath, { force: true });
  }
});

app.get("/api/whisper/status", (_req, res) => {
  res.json(checkWhisper(WHISPER_MODEL, rootDir));
});

/**
 * Collect words the LLM evaluator flagged so the aligner can downgrade them to
 * amber: quoted words in any issue's fix/message, plus words mentioned in
 * pronunciation issues that are actually part of the target fragment.
 */
function forcedAmberWordsFromIssues(issues: FeedbackIssue[], target: string): string[] {
  const targetTokens = new Set(tokenize(target));
  const words = new Set<string>();
  for (const issue of issues) {
    const texts = [issue.fix, issue.message].filter((t): t is string => typeof t === "string" && t.length > 0);
    for (const t of texts) {
      for (const quoted of t.match(/"[^"]+"/g) ?? []) {
        for (const w of tokenize(quoted)) words.add(w);
      }
      if (issue.category === "pronunciation") {
        for (const w of tokenize(t)) {
          if (targetTokens.has(w)) words.add(w);
        }
      }
    }
  }
  return [...words];
}

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
    const whisper = checkWhisper(WHISPER_MODEL, rootDir);
    if (!whisper.available) return res.status(400).json({ error: whisper.hint });
    if (!whisper.modelReady) {
      try {
        await downloadModel(WHISPER_MODEL, rootDir);
      } catch (err) {
        return res.status(500).json({ error: `Model download failed: ${(err as Error).message}` });
      }
      return res.status(400).json({ error: "Model downloaded. Please record again.", code: "MODEL_DOWNLOADED" });
    }

    const tmpDir = join(rootDir, "data", "tmp");
    mkdirSync(tmpDir, { recursive: true });
    const wavPath = join(tmpDir, `attempt-${randomUUID()}.wav`);
    writeFileSync(wavPath, buf);
    try {
      const result = await transcribeWords(wavPath, whisper.modelPath!, rootDir);
      text = result.text;
      words = result.words;
      durationMs = result.durationMs;
    } finally {
      rmSync(wavPath, { force: true });
    }
  }

  try {
    const { evaluation } = await evaluateFragment(candidates(), {
      target,
      userText: text,
      question,
      level,
    });
    const forcedAmberWords = evaluation.provider === "none" ? [] : forcedAmberWordsFromIssues(evaluation.issues, target);
    const align = words.length > 0 ? alignWords(words, target, { forcedAmberWords }) : alignTextWords(text, target);
    const passed = align.score >= passThreshold;
    persistAttempt({
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
    res.json({
      text,
      words: align.words,
      score: align.score,
      matched: align.matched,
      missing: align.missing,
      extra: align.extra,
      issues: evaluation.issues,
      verdict: evaluation.verdict,
      next: evaluation.next,
      tips: evaluation.tips,
      provider: evaluation.provider,
      durationMs,
      coachLine: buildFeedbackText({
        score: align.score,
        passed,
        missing: align.missing,
        tips: evaluation.tips,
      }),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ---------------------------------------------------------------------------
// TTS — Piper neural voice with edge-tts fallback (feature 007)
// ---------------------------------------------------------------------------

/**
 * Resolve the active TTS engine and return a combined status payload.
 *
 * Engine resolution:
 *   - Piper (local) is preferred whenever binary + voice model are present.
 *   - edge-tts (online) is used only when Piper is missing AND the server is
 *     not in OFFLINE_MODE (feature 006 forces the local stack).
 *   - Otherwise no server engine is available and the browser must fall back
 *     to `speechSynthesis`.
 */
function ttsStatus() {
  const piper = checkPiper(rootDir);
  const edge = checkEdgeTts();
  let engine: "piper" | "edge-tts" | null = null;
  if (piper.available && piper.voiceReady) {
    engine = "piper";
  } else if (!OFFLINE_MODE && edge.available) {
    engine = "edge-tts";
  }
  return {
    engine,
    offline: OFFLINE_MODE,
    piper: {
      available: piper.available,
      voiceReady: piper.voiceReady,
      voice: piper.voiceName,
      hint: piper.hint,
    },
    edge: {
      available: edge.available,
      voice: DEFAULT_EDGE_VOICE,
      hint: edge.hint,
    },
  };
}

/** Report TTS readiness for the frontend (same shape as `/api/health`'s tts). */
app.get("/api/tts/status", (_req, res) => {
  res.json(ttsStatus());
});

const TTS_MAX_CHARS = 1000;
const TTS_MAX_PAUSE_MS = 10_000;
const RATE_MIN = 0.5;
const RATE_MAX = 2;

/** Parse a numeric query param within bounds, falling back to `fallback`. */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * Serve TTS audio as a binary file.
 *
 * Query params:
 *   text        — text to speak (required unless `segments` given; ≤ 1000 chars)
 *   segments    — repeatable param for multi-fragment synthesis with measured
 *                 silence *between* them (e.g. "Repeat after me" + fragment);
 *                 `pauseAfterMs` is the inter-fragment silence
 *   pauseAfterMs — silence appended after `text` (single-text route), or the
 *                 pause inserted between `segments` — ≤ 10 s
 *   rate        — speed factor 0.5–2 (Piper length_scale / edge --rate)
 *   voice       — Piper voice id (optional; validated against supported voices)
 *
 * Engine chain (server-side): Piper → edge-tts (unless OFFLINE_MODE) →
 * 503 so the frontend can fall back to browser `speechSynthesis`.
 */
app.get("/api/tts", async (req, res) => {
  const segmentsParam = req.query.segments;
  const segments = Array.isArray(segmentsParam)
    ? segmentsParam.map(String)
    : typeof segmentsParam === "string" && segmentsParam
      ? [segmentsParam]
      : [];
  const text = typeof req.query.text === "string" ? req.query.text.trim() : "";
  const pauseAfterMs = clampNumber(req.query.pauseAfterMs, 0, TTS_MAX_PAUSE_MS, 0);
  const rate = clampNumber(req.query.rate, RATE_MIN, RATE_MAX, 1);
  const voice = typeof req.query.voice === "string" && req.query.voice ? req.query.voice : undefined;

  const cleanSegments = segments.map((s) => s.trim()).filter(Boolean);
  const totalChars = cleanSegments.length
    ? cleanSegments.reduce((sum, s) => sum + s.length, 0)
    : text.length;

  if (!cleanSegments.length && !text) {
    return res.status(400).json({ error: "text or segments query parameter is required." });
  }
  if (totalChars === 0) {
    return res.status(400).json({ error: "Text must not be empty." });
  }
  if (totalChars > TTS_MAX_CHARS) {
    return res.status(400).json({ error: `Text exceeds ${TTS_MAX_CHARS} character limit.` });
  }

  const status = ttsStatus();
  if (status.engine === null) {
    return res.status(503).json({
      error: "tts-unavailable",
      hint: status.piper.hint || status.edge.hint || "No local TTS engine is installed.",
    });
  }

  // Voice selection only applies to Piper; edge-tts keeps its default voice.
  if (status.engine === "piper" && voice && !SUPPORTED_VOICES.includes(voice)) {
    return res.status(400).json({ error: `Unsupported voice "${voice}". Supported: ${SUPPORTED_VOICES.join(", ")}.` });
  }

  const tmpDir = join(rootDir, "data", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const ext = status.engine === "edge-tts" ? "mp3" : "wav";
  const outPath = join(tmpDir, `tts-${randomUUID()}.${ext}`);

  try {
    let audio: Buffer;
    let mime: string;
    if (status.engine === "piper") {
      const lengthScale = 1 / rate;
      audio = cleanSegments.length
        ? await piperSynthesizeSegments(cleanSegments, rootDir, { pauseBetweenMs: pauseAfterMs, lengthScale, voice })
        : await piperSynthesize(text, rootDir, { pauseAfterMs, lengthScale, voice });
      mime = "audio/wav";
    } else {
      audio = await synthesizeEdge(cleanSegments.length ? cleanSegments.join(" ") : text, rootDir, {
        rate,
      });
      mime = "audio/mpeg";
    }
    writeFileSync(outPath, audio);
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Length", String(audio.length));
    res.sendFile(outPath, () => {
      rmSync(outPath, { force: true });
    });
  } catch (err) {
    rmSync(outPath, { force: true });
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/chat", async (req, res) => {
  const { message, provider: providerReq } = req.body ?? {};
  if (typeof message !== "string" || message.trim().length === 0) {
    return res.status(400).json({ error: "message is required." });
  }
  const profile = storage.loadProfile();
  const sessions = storage.loadAllSessions();
  const memory = buildLearnerMemory(profile, sessions);
  const messages: ChatMessage[] = [
    { role: "system", content: `You are a friendly English speaking coach. Answer in plain English. Keep it helpful and concise.\nLearner memory: ${memory}` },
    { role: "user", content: message },
  ];
  try {
    const result = await completeWithFallback(candidates(providerReq), messages, { maxTokens: 4096 });
    res.json({ reply: result.text, provider: result.provider });
  } catch (err) {
    const mail = /^\S+@\S+\.\S+$/.test(message.trim());
    const fallback = mail
      ? "Got it. Try: \"I'm writing to ask about…\" or \"Would it be possible to…?\" — phrase requests as questions for a more professional tone."
      : "Here's a cleaner way to say it. You can ask me to correct any specific phrase you're unsure about.";
    res.json({ reply: fallback, provider: "local", offline: true });
  }
});

function avgSessionScore(s: SessionV2): number | null {
  const scores = s.questions.flatMap((q) => q.fragments.flatMap((f) => f.attempts.map((a) => a.score)));
  return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
}

const port = Number(env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`English AI Coach running at http://localhost:${port}`);
  console.log(`LLM primary: ${primaryProviderId} · provider count: ${providers.length}`);
  console.log(`Whisper: ${checkWhisper(WHISPER_MODEL, rootDir).hint}`);
});