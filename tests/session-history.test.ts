import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStorage,
  fallbackTitle,
  groupSessionsByRecency,
  sessionProgress,
  sessionScore,
  toSessionSummary,
  type Session,
  type SessionConfig,
  type SessionStatus,
  type SessionV2,
} from "../src/lib/storage.ts";
import { handleSessionStartRequest } from "../src/lib/session-start.ts";
import type { Candidate } from "../src/lib/practice.ts";

// ---------------------------------------------------------------------------
// Fixtures (same patterns as storage.test.ts / session-start.test.ts)
// ---------------------------------------------------------------------------

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engcoach-history-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makeConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    topicPrompt: "Mock tech interview for a junior backend engineer focusing on system design",
    level: "B2",
    category: "Mock Tech Interview",
    accent: "General American (US)",
    phonemes: [],
    contextFiles: [],
    settingsSnapshot: { version: 1, overrides: {} },
    ...overrides,
  };
}

function makeSession(id: string, updatedAt: string, status: SessionStatus = "completed"): SessionV2 {
  const config = makeConfig();
  return {
    id,
    status,
    createdAt: updatedAt,
    updatedAt,
    config,
    provider: "zen",
    questions: [],
    title: fallbackTitle(config.topicPrompt),
  };
}

function writeSession(session: SessionV2): void {
  writeFileSync(join(dir, "data", "sessions", `${session.id}.json`), JSON.stringify(session), "utf8");
}

/** Session with one question: 2 fragments (one passed with attempts) + eval. */
function makePracticedSession(id: string, updatedAt: string, status: SessionStatus = "completed"): SessionV2 {
  const session = makeSession(id, updatedAt, status);
  session.questions = [
    {
      q: "Tell me about a difficult situation",
      answer: "Once in this company I had a difficult situation.",
      fragments: [
        {
          id: "f1",
          text: "Once in this company I had a difficult situation.",
          attempts: [
            { text: "Once in this company I had a difficult situation.", words: [], score: 82, startedAt: updatedAt, durationMs: 0 },
            { text: "Once in this company I had a difficult situation.", words: [], score: 91, startedAt: updatedAt, durationMs: 0 },
          ],
          passed: true,
        },
        {
          id: "f2",
          text: "I split the work into small tasks.",
          attempts: [],
          passed: false,
        },
      ],
      fullAttempt: null,
      eval: null,
    },
  ];
  return session;
}

// ---------------------------------------------------------------------------
// sessionScore / sessionProgress / toSessionSummary
// ---------------------------------------------------------------------------

test("history: sessionScore averages fragment attempts, null when none", () => {
  const empty = makeSession("empty", "2026-09-22T10:00:00.000Z");
  assert.equal(sessionScore(empty), null);

  const practiced = makePracticedSession("p", "2026-09-22T10:00:00.000Z");
  assert.equal(sessionScore(practiced), 87); // (82 + 91) / 2 = 86.5 → 87
});

test("history: sessionProgress counts questions with eval set", () => {
  const empty = makeSession("empty", "2026-09-22T10:00:00.000Z");
  assert.deepEqual(sessionProgress(empty), { answered: 0, total: 0, pct: 0 });

  const practiced = makePracticedSession("p", "2026-09-22T10:00:00.000Z");
  assert.deepEqual(sessionProgress(practiced), { answered: 0, total: 1, pct: 0 });

  practiced.questions[0].eval = {
    score: 80,
    verdict: "great",
    matched: [],
    missing: [],
    extra: [],
    issues: [],
    tips: [],
    next: true,
  };
  assert.deepEqual(sessionProgress(practiced), { answered: 1, total: 1, pct: 100 });
});

test("history: toSessionSummary extracts only light fields (no topicPrompt, no questions)", () => {
  const practiced = makePracticedSession("p", "2026-09-22T10:00:00.000Z");
  const summary = toSessionSummary(practiced)!;
  assert.ok(summary);
  assert.equal(summary.id, "p");
  assert.equal(summary.title, practiced.title);
  assert.equal(summary.level, "B2");
  assert.equal(summary.provider, "zen");
  assert.equal(summary.status, "completed");
  assert.equal(summary.updatedAt, practiced.updatedAt);
  assert.equal(summary.score, 87);
  assert.deepEqual(summary.progress, { answered: 0, total: 1, pct: 0 });
  assert.ok(!("topicPrompt" in summary));
  assert.ok(!("questions" in summary));
});

test("history: toSessionSummary migrates a v1 session", () => {
  const v1: Session = {
    id: "v1-session",
    date: "2026-09-12T23:46:15.436Z",
    category: "star",
    level: "B2",
    provider: "cloudflare",
    question: "Tell me about a difficult situation",
    context: "",
    fragments: [
      {
        id: "f1",
        stage: "Situation",
        text: "Once in this company I had a difficult situation.",
        attempts: [{ text: "Once in this company I had a difficult situation.", score: 82, missing: [], extra: [], issues: [], verdict: "great" }],
        passed: true,
      },
    ],
  };
  const summary = toSessionSummary(v1)!;
  assert.ok(summary);
  assert.equal(summary.id, "v1-session");
  assert.equal(summary.status, "completed");
  assert.equal(summary.level, "B2");
  assert.equal(summary.score, 82);
  assert.deepEqual(summary.progress, { answered: 0, total: 1, pct: 0 });
});

test("history: toSessionSummary returns undefined for corrupt input", () => {
  assert.equal(toSessionSummary(null), undefined);
  assert.equal(toSessionSummary("garbage"), undefined);
  assert.equal(toSessionSummary({ id: 42 }), undefined);
});

// ---------------------------------------------------------------------------
// listSessionSummaries
// ---------------------------------------------------------------------------

test("history: listSessionSummaries returns light summaries sorted by updatedAt", () => {
  const s = createStorage(dir);
  writeSession(makePracticedSession("old", "2026-09-01T10:00:00.000Z"));
  writeSession(makePracticedSession("recent", "2026-09-20T10:00:00.000Z"));
  writeSession(makePracticedSession("active", "2026-09-21T10:00:00.000Z", "active"));

  const summaries = s.listSessionSummaries();
  assert.deepEqual(summaries.map((x) => x.id), ["active", "recent", "old"]);
  assert.equal(summaries[0].status, "active");
  assert.equal(summaries[0].score, 87);
  assert.ok(!("questions" in summaries[0]));
  assert.ok(!("topicPrompt" in summaries[0]));
});

test("history: listSessionSummaries filters by status and limit", () => {
  const s = createStorage(dir);
  writeSession(makePracticedSession("a", "2026-09-20T10:00:00.000Z", "active"));
  writeSession(makePracticedSession("b", "2026-09-21T10:00:00.000Z", "completed"));
  writeSession(makePracticedSession("c", "2026-09-22T10:00:00.000Z", "completed"));

  const active = s.listSessionSummaries({ status: "active" });
  assert.deepEqual(active.map((x) => x.id), ["a"]);

  const limited = s.listSessionSummaries({ limit: 2 });
  assert.deepEqual(limited.map((x) => x.id), ["c", "b"]);
});

test("history: listSessionSummaries skips corrupt files defensively", () => {
  const s = createStorage(dir);
  writeSession(makePracticedSession("ok", "2026-09-22T10:00:00.000Z"));
  writeFileSync(join(dir, "data", "sessions", "broken.json"), "{broken", "utf8");
  const summaries = s.listSessionSummaries();
  assert.deepEqual(summaries.map((x) => x.id), ["ok"]);
});

test("history: groupSessionsByRecency buckets summaries like full sessions", () => {
  const now = new Date(2026, 8, 22, 15, 0, 0); // local Sep 22 2026
  const summaries = [
    toSessionSummary(makeSession("older", new Date(2026, 8, 1, 10, 0).toISOString()))!,
    toSessionSummary(makeSession("last7", new Date(2026, 8, 16, 10, 0).toISOString()))!,
    toSessionSummary(makeSession("yesterday", new Date(2026, 8, 21, 10, 0).toISOString()))!,
    toSessionSummary(makeSession("today", new Date(2026, 8, 22, 10, 0).toISOString()))!,
  ];
  const groups = groupSessionsByRecency(summaries, now);
  assert.deepEqual(groups.map((g) => g.key), ["today", "yesterday", "last7", "older"]);
  assert.deepEqual(groups[0].sessions.map((x) => x.id), ["today"]);
  assert.deepEqual(groups[1].sessions.map((x) => x.id), ["yesterday"]);
  assert.deepEqual(groups[2].sessions.map((x) => x.id), ["last7"]);
  assert.deepEqual(groups[3].sessions.map((x) => x.id), ["older"]);
});

// ---------------------------------------------------------------------------
// deleteSession
// ---------------------------------------------------------------------------

test("history: deleteSession removes the file and its context bucket", () => {
  const s = createStorage(dir);
  const id = s.createSession(makeConfig());
  const textRef = s.saveContextText(id, { name: "job.md", size: 9, kind: "md" }, "the job spec");
  assert.ok(existsSync(join(dir, "data", "tmp", "context", id, textRef)));

  assert.equal(s.deleteSession(id), true);
  assert.equal(s.loadSession(id), undefined);
  assert.equal(existsSync(join(dir, "data", "sessions", `${id}.json`)), false);
  assert.equal(existsSync(join(dir, "data", "tmp", "context", id)), false);
});

test("history: deleteSession returns false for missing or unsafe ids", () => {
  const s = createStorage(dir);
  assert.equal(s.deleteSession("does-not-exist"), false);
  assert.equal(s.deleteSession("../../profile"), false);
});

// ---------------------------------------------------------------------------
// copyContextText
// ---------------------------------------------------------------------------

test("history: copyContextText duplicates a text into the target bucket", () => {
  const s = createStorage(dir);
  const textRef = s.saveContextText("draft", { name: "job.md", size: 9, kind: "md" }, "the job spec");
  assert.equal(s.copyContextText("draft", "session-1", textRef), true);
  assert.equal(s.loadContextText("session-1", textRef), "the job spec");
});

test("history: copyContextText falls back to the draft bucket", () => {
  const s = createStorage(dir);
  const textRef = s.saveContextText("draft", { name: "job.md", size: 9, kind: "md" }, "the job spec");
  // Source bucket has no file; the draft fallback resolves it.
  assert.equal(s.copyContextText("session-0", "session-1", textRef), true);
  assert.equal(s.loadContextText("session-1", textRef), "the job spec");
});

test("history: copyContextText returns false when the text cannot be resolved", () => {
  const s = createStorage(dir);
  assert.equal(s.copyContextText("draft", "session-1", "pdf-missing.txt"), false);
  assert.equal(s.copyContextText("bad/../bucket", "session-1", "pdf-missing.txt"), false);
});

// ---------------------------------------------------------------------------
// session/start with contextBucket (feature 109 "Practicar de nuevo")
// ---------------------------------------------------------------------------

const FAKE_FIRST = `{"question":"Tell me about a time you led a difficult project.","fragments":[{"id":"f1","stage":"Opening","text":"Last year I led a project with a very tight deadline."}]}`;
const FAKE_TITLE = `{"title":"Leading a Difficult Project"}`;

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

test("session/start: contextBucket resolves files from the previous session and copies them", async () => {
  const s = createStorage(dir);
  const prevId = s.createSession(makeConfig());
  const textRef = s.saveContextText(prevId, { name: "job.md", size: 9, kind: "md" }, "the job spec");

  const res = await handleSessionStartRequest(s, [fake("zen", FAKE_FIRST), fake("zen", FAKE_TITLE)], {
    topicPrompt: "Role",
    level: "B2",
    contextBucket: prevId,
    contextFiles: [{ name: "job.md", size: 9, kind: "md", textRef }],
  });
  assert.equal(res.status, 200);

  const { sessionId } = res.json as { sessionId: string };
  const session = s.loadSession(sessionId)!;
  assert.deepEqual(session.config.contextFiles, [{ name: "job.md", size: 9, kind: "md", textRef }]);
  // The new session is self-contained: its own bucket holds the copied text.
  assert.equal(s.loadContextText(sessionId, textRef), "the job spec");
});