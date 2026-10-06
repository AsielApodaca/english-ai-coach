import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildContextSummary,
  computeAdaptive,
  handleNextQuestionRequest,
  rollingAverage,
  rollingScores,
} from "../src/lib/practice/continuous.ts";
import { createStorage, DEFAULT_ACCENT, type Level, type SessionV2 } from "../src/lib/session/storage.ts";
import { RIGOR_THRESHOLDS } from "../src/lib/settings/settings.ts";
import { ProviderError } from "../src/lib/providers/index.ts";
import type { Candidate } from "../src/lib/practice/practice.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_NEXT = `{"question":"How did you handle a conflict inside your team?","fragments":[{"id":"f1","stage":"Opening","text":"I once had a conflict about priorities."},{"id":"f2","stage":"Main point","text":"I scheduled a one-on-one to understand both sides."},{"id":"f3","stage":"Closing","text":"We agreed on a shared plan and shipped on time."}]}`;

/** Fake provider that returns a fixed reply. */
function fake(id: string, reply: string): Candidate {
  return {
    id: id as never,
    async available() {
      return true;
    },
    async complete() {
      return reply;
    },
  };
}

/** Fake provider that always fails (LLM outage). */
function failing(id: string): Candidate {
  return {
    id: id as never,
    async available() {
      return true;
    },
    async complete() {
      throw new ProviderError("boom", true, id as never);
    },
  };
}

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engcoach-cont-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Build a session with `count` questions; `scores[i]` feeds q.eval.score. */
function makeSession(
  storage: ReturnType<typeof createStorage>,
  opts: { level?: Level; rigor?: string; count?: number; scores?: number[]; lastEvalNull?: boolean } = {},
): SessionV2 {
  const rigor = opts.rigor ?? "Balanceado";
  const id = storage.createSession(
    {
      topicPrompt: "Simula ser un Engineering Manager de Google.",
      level: opts.level ?? "B1",
      category: "free",
      accent: DEFAULT_ACCENT,
      phonemes: [],
      contextFiles: [],
      settingsSnapshot: {
        version: 1,
        overrides: {
          rigor,
          fillers: "Moderado",
          adaptive: { enabled: true, up: 90, down: 65 },
          provider: "auto",
          autoAdvance: false,
          passThreshold: RIGOR_THRESHOLDS[rigor as keyof typeof RIGOR_THRESHOLDS],
        },
      },
    },
    { title: "EM Interview", provider: "amber" },
  );
  const session = storage.loadSession(id)!;
  const count = opts.count ?? 0;
  const scores = opts.scores ?? [];
  session.questions = Array.from({ length: count }, (_, i) => {
    const score = scores[i];
    const evaluated = score !== undefined && !(opts.lastEvalNull && i === count - 1);
    return {
      q: `Question ${i + 1}`,
      answer: `Answer ${i + 1}`,
      fragments: [{ id: "f1", text: `Answer ${i + 1}`, attempts: [], passed: true }],
      fullAttempt: {
        text: `Answer ${i + 1}`,
        words: [],
        score: score ?? 80,
        startedAt: new Date().toISOString(),
        durationMs: 0,
      },
      eval: evaluated
        ? { score: score ?? 80, verdict: "great", matched: [], missing: [], extra: [], issues: [], tips: [], next: true }
        : null,
    };
  });
  storage.saveSession(session);
  return storage.loadSession(id)!;
}

// ---------------------------------------------------------------------------
// rollingScores / rollingAverage
// ---------------------------------------------------------------------------

test("continuous: rollingScores returns the last 3 evaluated scores", () => {
  const s = createStorage(dir);
  const session = makeSession(s, { count: 4, scores: [70, 85, 90, 95] });
  assert.deepEqual(rollingScores(session), [85, 90, 95]);
});

test("continuous: rollingScores skips unevaluated questions", () => {
  const s = createStorage(dir);
  const session = makeSession(s, { count: 3, scores: [70, 85], lastEvalNull: true });
  assert.deepEqual(rollingScores(session), [70, 85]);
});

test("continuous: rollingAverage", () => {
  assert.equal(rollingAverage([90, 90, 90]), 90);
  assert.equal(rollingAverage([]), 0);
  assert.equal(rollingAverage([60, 55, 70]), 61.666666666666664);
});

// ---------------------------------------------------------------------------
// computeAdaptive
// ---------------------------------------------------------------------------

test("continuous: computeAdaptive steps up level and rigor above the up threshold", () => {
  const res = computeAdaptive([95, 92, 90], { level: "B1", rigor: "Balanceado" }, { enabled: true, up: 90, down: 65 });
  assert.equal(res.level, "B2");
  assert.equal(res.rigor, "Estricto");
  assert.equal(res.message, "Dificultad sube a B2 · rigor Estricto");
});

test("continuous: computeAdaptive steps down below the down threshold", () => {
  const res = computeAdaptive([60, 55, 70], { level: "B2", rigor: "Balanceado" }, { enabled: true, up: 90, down: 65 });
  assert.equal(res.level, "B1");
  assert.equal(res.rigor, "Flexible");
  assert.equal(res.message, "Dificultad baja a B1 · rigor Flexible");
});

test("continuous: computeAdaptive needs at least 3 scores", () => {
  const res = computeAdaptive([95, 92], { level: "B1", rigor: "Balanceado" }, { enabled: true, up: 90, down: 65 });
  assert.equal(res.level, "B1");
  assert.equal(res.rigor, "Balanceado");
  assert.equal(res.message, null);
});

test("continuous: computeAdaptive is inert when disabled", () => {
  const res = computeAdaptive([95, 92, 90], { level: "B1", rigor: "Balanceado" }, { enabled: false, up: 90, down: 65 });
  assert.equal(res.level, "B1");
  assert.equal(res.rigor, "Balanceado");
  assert.equal(res.message, null);
});

test("continuous: computeAdaptive clamps at C2/Estricto (only rigor moves)", () => {
  const res = computeAdaptive([100, 100, 100], { level: "C2", rigor: "Balanceado" }, { enabled: true, up: 90, down: 65 });
  assert.equal(res.level, "C2");
  assert.equal(res.rigor, "Estricto");
  assert.equal(res.message, "Rigor sube a Estricto");
});

test("continuous: computeAdaptive clamps at A1/Flexible (only level moves)", () => {
  const res = computeAdaptive([10, 20, 30], { level: "A1", rigor: "Flexible" }, { enabled: true, up: 90, down: 65 });
  assert.equal(res.level, "A1");
  assert.equal(res.rigor, "Flexible");
  assert.equal(res.message, null);
});

test("continuous: computeAdaptive stays put in the middle band", () => {
  const res = computeAdaptive([70, 75, 80], { level: "B1", rigor: "Balanceado" }, { enabled: true, up: 90, down: 65 });
  assert.equal(res.level, "B1");
  assert.equal(res.rigor, "Balanceado");
  assert.equal(res.message, null);
});

// ---------------------------------------------------------------------------
// buildContextSummary
// ---------------------------------------------------------------------------

test("continuous: buildContextSummary includes topic and last exchanges", () => {
  const s = createStorage(dir);
  const session = makeSession(s, { count: 2, scores: [80, 85] });
  const summary = buildContextSummary(session);
  assert.ok(summary.includes("Topic: Simula ser un Engineering Manager de Google."));
  assert.ok(summary.includes("Q: Question 1"));
  assert.ok(summary.includes("A: Answer 1"));
  assert.ok(summary.includes("Q: Question 2"));
  assert.ok(summary.includes("A: Answer 2"));
});

// ---------------------------------------------------------------------------
// handleNextQuestionRequest — validation
// ---------------------------------------------------------------------------

test("next-question: missing sessionId → 400", async () => {
  const s = createStorage(dir);
  const res = await handleNextQuestionRequest(s, [fake("amber", FAKE_NEXT)], {});
  assert.equal(res.status, 400);
  assert.match(res.json.error as string, /sessionId/);
});

test("next-question: unknown session → 404", async () => {
  const s = createStorage(dir);
  const res = await handleNextQuestionRequest(s, [fake("amber", FAKE_NEXT)], { sessionId: "nope" });
  assert.equal(res.status, 404);
});

test("next-question: completed session → 409", async () => {
  const s = createStorage(dir);
  const session = makeSession(s, { count: 1, scores: [80] });
  session.status = "completed";
  s.saveSession(session);
  const res = await handleNextQuestionRequest(s, [fake("amber", FAKE_NEXT)], { sessionId: session.id });
  assert.equal(res.status, 409);
});

// ---------------------------------------------------------------------------
// handleNextQuestionRequest — idempotent retry
// ---------------------------------------------------------------------------

test("next-question: last question without eval is returned idempotently", async () => {
  const s = createStorage(dir);
  const session = makeSession(s, { count: 2, scores: [80], lastEvalNull: true });
  const res = await handleNextQuestionRequest(s, [fake("amber", FAKE_NEXT)], { sessionId: session.id });
  assert.equal(res.status, 200);
  assert.equal(res.json.idempotent, true);
  assert.equal((res.json.question as { q: string }).q, "Question 2");
  // no duplicate question was pushed
  assert.equal(s.loadSession(session.id)!.questions.length, 2);
});

// ---------------------------------------------------------------------------
// handleNextQuestionRequest — attached document context (feature 104)
// ---------------------------------------------------------------------------

/** Fake provider that records every prompt it receives (for prompt assertions). */
function capturingFake(id: string, reply: string): { candidate: Candidate; messages: unknown[][] } {
  const messages: unknown[][] = [];
  return {
    messages,
    candidate: {
      id: id as never,
      async available() {
        return true;
      },
      async complete(msgs: unknown[]) {
        messages.push(msgs);
        return reply;
      },
    },
  };
}

/** Join every user message of a recorded call so assertions read the prompt. */
function promptsOf(messages: unknown[][]): string {
  return messages
    .map((msgs) => (msgs as Array<{ role: string; content: string }>).find((m) => m.role === "user")?.content ?? "")
    .join("\n");
}

test("next-question: the attached document is injected into the prompt", async () => {
  const s = createStorage(dir);
  const session = makeSession(s, { count: 1, scores: [80] });
  const textRef = s.saveContextText(session.id, { name: "resume.md", size: 44, kind: "md" }, "I led a migration to TypeScript in 2024.");
  session.config.contextFiles = [{ name: "resume.md", size: 44, kind: "md", textRef }];
  s.saveSession(session);

  const { candidate, messages } = capturingFake("amber", FAKE_NEXT);
  const res = await handleNextQuestionRequest(s, [candidate], { sessionId: session.id });

  assert.equal(res.status, 200);
  // Within budget the texts are injected verbatim: exactly one LLM call.
  assert.equal(messages.length, 1, "no summarizer call for a small document");
  const prompt = promptsOf(messages);
  assert.ok(prompt.includes("DOCUMENT CONTEXT"), "document block must reach the prompt");
  assert.ok(prompt.includes("I led a migration to TypeScript in 2024."), "raw file text must be injected");
  assert.ok(prompt.includes("never JSON"), "the wrapper must mark the text as data");
  assert.ok(prompt.includes("--- resume.md (md) ---"));
  assert.ok(prompt.includes("--- END DOCUMENT CONTEXT ---"));
});

test("next-question: no document in the session means no DOCUMENT CONTEXT", async () => {
  const s = createStorage(dir);
  const session = makeSession(s, { count: 1, scores: [80] });
  const { candidate, messages } = capturingFake("amber", FAKE_NEXT);
  const res = await handleNextQuestionRequest(s, [candidate], { sessionId: session.id });

  assert.equal(res.status, 200);
  assert.equal(messages.length, 1);
  assert.ok(!promptsOf(messages).includes("DOCUMENT CONTEXT"));
});

test("next-question: a context file whose text is missing is skipped", async () => {
  const s = createStorage(dir);
  const session = makeSession(s, { count: 1, scores: [80] });
  session.config.contextFiles = [{ name: "gone.pdf", size: 5, kind: "pdf", textRef: "gone.txt" }];
  s.saveSession(session);

  const { candidate, messages } = capturingFake("amber", FAKE_NEXT);
  const res = await handleNextQuestionRequest(s, [candidate], { sessionId: session.id });

  assert.equal(res.status, 200);
  assert.ok(!promptsOf(messages).includes("DOCUMENT CONTEXT"));
});

test("next-question: an oversized document is summarized by one extra LLM call", async () => {
  const s = createStorage(dir);
  const session = makeSession(s, { count: 1, scores: [80] });
  const bigText = "migration details ".repeat(2000); // > CONTEXT_BUDGET (16k chars)
  const textRef = s.saveContextText(session.id, { name: "notes.md", size: bigText.length, kind: "md" }, bigText);
  session.config.contextFiles = [{ name: "notes.md", size: bigText.length, kind: "md", textRef }];
  s.saveSession(session);

  const { candidate, messages } = capturingFake("amber", FAKE_NEXT);
  const res = await handleNextQuestionRequest(s, [candidate], { sessionId: session.id });

  assert.equal(res.status, 200);
  assert.equal(messages.length, 2, "summarizer call + question call");
  const summarizeCall = promptsOf([messages[0]]);
  assert.ok(summarizeCall.includes("Summarize the following document"), "first call must summarize");
  assert.ok(summarizeCall.includes("Learner memory:"), "the summarizer must carry the learner memory");
  const questionCall = promptsOf([messages[1]]);
  assert.ok(questionCall.includes("DOCUMENT CONTEXT (summarized)"), "summary replaces the raw text");
});

// ---------------------------------------------------------------------------
// handleNextQuestionRequest — happy path with adaptive adjustment
// ---------------------------------------------------------------------------

test("next-question: generates Q_n+1 and applies the adaptive step", async () => {
  const s = createStorage(dir);
  const session = makeSession(s, { level: "B1", count: 3, scores: [95, 92, 90] });
  const res = await handleNextQuestionRequest(s, [fake("amber", FAKE_NEXT)], { sessionId: session.id });

  assert.equal(res.status, 200);
  const json = res.json as {
    question: { q: string; answer: string; fragments: unknown[] };
    provider: string;
    adjustment: string | null;
    level: string;
    rigor: string;
  };
  assert.equal(json.question.q, "How did you handle a conflict inside your team?");
  assert.equal(json.question.fragments.length, 3);
  assert.equal(json.provider, "amber");
  assert.equal(json.adjustment, "Dificultad sube a B2 · rigor Estricto");
  assert.equal(json.level, "B2");
  assert.equal(json.rigor, "Estricto");

  const stored = s.loadSession(session.id)!;
  assert.equal(stored.questions.length, 4);
  const pushed = stored.questions.at(-1)!;
  assert.equal(pushed.q, json.question.q);
  assert.equal(pushed.fullAttempt, null);
  assert.equal(pushed.eval, null);
  assert.deepEqual(pushed.fragments[0].attempts, []);
  assert.equal(pushed.fragments[0].passed, false);
  // adaptive adjustment persisted into the session config
  assert.equal(stored.config.level, "B2");
  assert.equal(stored.config.settingsSnapshot.overrides.rigor, "Estricto");
  assert.equal(stored.config.settingsSnapshot.overrides.passThreshold, 93);
});

test("next-question: no adjustment when the rolling average is in the middle band", async () => {
  const s = createStorage(dir);
  const session = makeSession(s, { level: "B1", count: 3, scores: [70, 75, 80] });
  const res = await handleNextQuestionRequest(s, [fake("amber", FAKE_NEXT)], { sessionId: session.id });
  assert.equal(res.status, 200);
  assert.equal(res.json.adjustment, null);
  assert.equal(res.json.level, "B1");
  assert.equal(res.json.rigor, "Balanceado");
  const stored = s.loadSession(session.id)!;
  assert.equal(stored.config.level, "B1");
  assert.equal(stored.config.settingsSnapshot.overrides.rigor, "Balanceado");
});

// ---------------------------------------------------------------------------
// handleNextQuestionRequest — LLM failure keeps the session active
// ---------------------------------------------------------------------------

test("next-question: LLM failure → 502, session stays active and unchanged", async () => {
  const s = createStorage(dir);
  const session = makeSession(s, { count: 3, scores: [95, 92, 90] });
  const res = await handleNextQuestionRequest(s, [failing("amber"), failing("gemini")], { sessionId: session.id });
  assert.equal(res.status, 502);
  assert.ok((res.json.error as string).length > 0);
  const stored = s.loadSession(session.id)!;
  assert.equal(stored.status, "active");
  assert.equal(stored.questions.length, 3);
  assert.equal(stored.config.level, "B1");
  assert.equal(stored.config.settingsSnapshot.overrides.rigor, "Balanceado");
});