import express from "express";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { buildProviders, completeWithFallback, providerById, providerStatus } from "./lib/providers/index.ts";
import { type ChatMessage, type ProviderId } from "./lib/providers/types.ts";
import { CATEGORY_STAGES, type Candidate, type Category, type Level } from "./lib/practice.ts";
import { evaluateFragment, generatePracticeSet } from "./lib/practice.ts";
import { buildLearnerMemory, buildNextStep, computeStats, updateProfile } from "./lib/learner.ts";
import { checkWhisper, transcribeWav, downloadModel } from "./lib/whisper.ts";
import { createStorage, type Profile, type Session, type SessionAttempt } from "./lib/storage.ts";

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
app.use(express.json({ limit: "1mb" }));
app.use(express.static(join(rootDir, "public")));

function isCategory(v: unknown): v is Category {
  return typeof v === "string" && v in CATEGORY_STAGES;
}
function isLevel(v: unknown): v is Level {
  return v === "B1" || v === "B2" || v === "C1";
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
}): void {
  const { evaluation, sessionId, fragmentId, userText } = params;
  if (!sessionId || !fragmentId) return;
  const session = storage.loadSession(sessionId);
  if (!session) return;
  const frag = session.fragments.find((f) => f.id === fragmentId);
  if (!frag) return;
  const attempt: SessionAttempt = {
    text: userText,
    score: evaluation.score,
    missing: evaluation.missing,
    extra: evaluation.extra,
    issues: evaluation.issues,
    verdict: evaluation.verdict,
  };
  frag.attempts.push(attempt);
  if (evaluation.next) frag.passed = true;
  // refresh profile from aggregated data
  const profile = storage.loadProfile();
  const sessions = storage.loadAllSessions();
  updateProfile(profile, sessions);
  profile.recentTopics = [session.question, ...(profile.recentTopics ?? []).filter((t) => t !== session.question)].slice(0, 12);
  storage.saveProfile(profile);
  storage.saveSession(session);
}

app.post("/api/session/save", async (req, res) => {
  const { id, category = "free", level = "B2", provider = "unknown", question = "", context = "", fragments = [], fullAnswer } =
    req.body ?? {};
  const session: Session = {
    id: typeof id === "string" && id ? id : randomUUID(),
    date: new Date().toISOString(),
    category,
    level,
    provider,
    question: String(question),
    context: String(context),
    fragments: Array.isArray(fragments)
      ? fragments.map((f: { id?: string; stage?: string; text?: string; attempts?: SessionAttempt[]; passed?: boolean }) => ({
          id: f.id ?? randomUUID(),
          stage: f.stage ?? "",
          text: f.text ?? "",
          attempts: Array.isArray(f.attempts) ? f.attempts : [],
          passed: Boolean(f.passed),
        }))
      : [],
    ...(fullAnswer ? { fullAnswer } : {}),
  };
  storage.saveSession(session);
  try {
    const { nextStep } = await buildNextStep(candidates(), storage.loadProfile(), storage.loadAllSessions());
    const profile = storage.loadProfile();
    profile.nextStep = nextStep;
    storage.saveProfile(profile);
    session.nextStep = nextStep;
    storage.saveSession(session);
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

app.get("/api/history", (_req, res) => {
  const sessions = storage.loadAllSessions();
  res.json({
    sessions: sessions.map((s) => ({
      id: s.id,
      date: s.date,
      category: s.category,
      level: s.level,
      question: s.question,
      avgScore: avgSessionScore(s),
      nextStep: s.nextStep,
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
      trend: sessions.flatMap((s) => s.fragments.flatMap((f) => f.attempts.map((a) => a.score))).slice(-30),
    },
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
    return res.status(400).json({ error: "Model downloaded. Please record again." });
  }
  const tmpDir = join(rootDir, "data", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const wavPath = join(tmpDir, `rec-${randomUUID()}.wav`);
  writeFileSync(wavPath, buf);
  try {
    const result = await transcribeWav(wavPath, whisper.modelPath!, rootDir);
    res.json({ text: result.text, durationMs: result.durationMs });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  } finally {
    rmSync(wavPath, { force: true });
  }
});

app.get("/api/whisper/status", (_req, res) => {
  res.json(checkWhisper(WHISPER_MODEL, rootDir));
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

function avgSessionScore(s: Session): number | null {
  const scores = s.fragments.flatMap((f) => f.attempts.map((a) => a.score));
  return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
}

const port = Number(env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`English AI Coach running at http://localhost:${port}`);
  console.log(`LLM primary: ${primaryProviderId} · provider count: ${providers.length}`);
  console.log(`Whisper: ${checkWhisper(WHISPER_MODEL, rootDir).hint}`);
});