import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createStorage,
  fallbackTitle,
  groupSessionsByRecency,
  type Session,
  type SessionConfig,
  type SessionStatus,
  type SessionV2,
} from "../src/lib/storage.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engcoach-test-"));
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
    provider: "gemini",
    questions: [],
    title: fallbackTitle(config.topicPrompt),
  };
}

function writeSession(dir: string, session: SessionV2): void {
  writeFileSync(join(dir, "data", "sessions", `${session.id}.json`), JSON.stringify(session), "utf8");
}

test("storage: empty profile defaults to level B1", () => {
  const s = createStorage(dir);
  const p = s.loadProfile();
  assert.equal(p.level, "B1");
});

test("storage: corrupted profile falls back to defaults", () => {
  const s = createStorage(dir);
  writeFileSync(join(dir, "data", "profile.json"), "{broken", "utf8");
  const p = s.loadProfile();
  assert.equal(p.level, "B1");
});

test("storage: profile level is normalized to a valid CEFR level", () => {
  const s = createStorage(dir);
  writeFileSync(join(dir, "data", "profile.json"), JSON.stringify({ level: "C1", categories: {}, weakErrors: {}, vocabGaps: [], recentTopics: [] }), "utf8");
  assert.equal(s.loadProfile().level, "C1");
  writeFileSync(join(dir, "data", "profile.json"), JSON.stringify({ level: "X9", categories: {}, weakErrors: {}, vocabGaps: [], recentTopics: [] }), "utf8");
  assert.equal(s.loadProfile().level, "B2");
});

test("storage: createSession writes an active session and returns its id", () => {
  const s = createStorage(dir);
  const config = makeConfig();
  const id = s.createSession(config);
  assert.ok(id.length > 0);
  const session = s.loadSession(id);
  assert.ok(session);
  assert.equal(session.status, "active");
  assert.equal(session.config.topicPrompt, config.topicPrompt);
  assert.equal(session.config.level, "B2");
  assert.equal(session.config.category, "Mock Tech Interview");
  assert.deepEqual(session.questions, []);
  assert.equal(session.title, fallbackTitle(config.topicPrompt));
  assert.equal(session.createdAt, session.updatedAt);
});

test("storage: createSession uses the provided title and provider", () => {
  const s = createStorage(dir);
  const id = s.createSession(makeConfig(), { title: "Junior SWE First Interview", provider: "gemini" });
  const session = s.loadSession(id);
  assert.ok(session);
  assert.equal(session.title, "Junior SWE First Interview");
  assert.equal(session.provider, "gemini");
});

test("storage: saveSession is idempotent and replaces the whole file", () => {
  const s = createStorage(dir);
  const id = s.createSession(makeConfig());
  const session = s.loadSession(id)!;
  session.questions.push({ q: "Q2", answer: "A2", fragments: [], fullAttempt: null, eval: null });
  s.saveSession(session);
  s.saveSession(session); // second save with the same state
  const loaded = s.loadSession(id)!;
  assert.equal(loaded.questions.length, 1); // no duplication
  assert.equal(loaded.questions[0].q, "Q2");
  assert.equal(loaded.status, "active");
});

test("storage: saveSession bumps updatedAt on every save (checkpoint)", () => {
  const s = createStorage(dir);
  const id = s.createSession(makeConfig());
  const first = s.loadSession(id)!;
  s.saveSession(first);
  const second = s.loadSession(id)!;
  assert.ok(second.updatedAt >= first.updatedAt);
  s.saveSession(second);
  const third = s.loadSession(id)!;
  assert.ok(third.updatedAt >= second.updatedAt);
});

test("storage: loadSession migrates a v1 session to v2 without rewriting the file", () => {
  const s = createStorage(dir);
  const v1: Session = {
    id: "v1-session",
    date: "2026-09-12T23:46:15.436Z",
    category: "star",
    level: "B2",
    provider: "cloudflare",
    question: "Tell me about a difficult situation",
    context: "Focus on action verbs",
    fragments: [
      {
        id: "f1",
        stage: "Situation",
        text: "Once in this company I had a difficult situation.",
        attempts: [{ text: "Once in this company I had a difficult situation.", score: 82, missing: [], extra: [], issues: [], verdict: "great" }],
        passed: false,
      },
    ],
    fullAnswer: { text: "Once in this company I had a difficult situation." },
  };
  writeFileSync(join(dir, "data", "sessions", "v1-session.json"), JSON.stringify(v1), "utf8");

  const loaded = s.loadSession("v1-session")!;
  assert.equal(loaded.status, "completed");
  assert.equal(loaded.questions.length, 1);
  assert.equal(loaded.questions[0].q, v1.question);
  assert.equal(loaded.questions[0].answer, v1.fullAnswer!.text);
  assert.equal(loaded.questions[0].fragments.length, 1);
  assert.equal(loaded.questions[0].fragments[0].attempts[0].score, 82);
  assert.equal(loaded.questions[0].fullAttempt, null);
  assert.equal(loaded.questions[0].eval, null);
  assert.equal(loaded.config.category, "star");
  assert.equal(loaded.config.level, "B2");
  assert.equal(loaded.config.accent, "General American (US)");
  assert.equal(loaded.provider, "cloudflare");

  // the v1 file on disk is untouched (read-only migration)
  const onDisk = JSON.parse(readFileSync(join(dir, "data", "sessions", "v1-session.json"), "utf8")) as Session;
  assert.ok(!("questions" in onDisk));
  assert.equal(onDisk.fragments.length, 1);
});

test("storage: saveSession refuses to overwrite a migrated v1 file", () => {
  const s = createStorage(dir);
  const v1: Session = {
    id: "v1-keep",
    date: "2026-09-12T23:46:15.436Z",
    category: "star",
    level: "B2",
    provider: "cloudflare",
    question: "Tell me about a difficult situation",
    context: "",
    fragments: [],
  };
  writeFileSync(join(dir, "data", "sessions", "v1-keep.json"), JSON.stringify(v1), "utf8");

  const loaded = s.loadSession("v1-keep")!;
  assert.throws(() => s.saveSession(loaded), /refusing to overwrite v1 session file/);
  const onDisk = readFileSync(join(dir, "data", "sessions", "v1-keep.json"), "utf8");
  assert.ok(!onDisk.includes('"questions"'));
});

test("storage: loadSession rejects unsafe session ids", () => {
  const s = createStorage(dir);
  assert.equal(s.loadSession("../../profile"), undefined);
  assert.throws(() => s.saveSession({ ...makeSession("../../escape", "now"), status: "completed" }), /refusing unsafe session id/);
});

test("storage: listSessions sorts by updatedAt descending and filters", () => {
  const s = createStorage(dir);
  writeSession(dir, makeSession("old", "2026-09-01T10:00:00.000Z"));
  writeSession(dir, makeSession("mid", "2026-09-10T10:00:00.000Z"));
  writeSession(dir, makeSession("recent", "2026-09-20T10:00:00.000Z"));
  writeSession(dir, makeSession("active", "2026-09-21T10:00:00.000Z", "active"));

  const all = s.listSessions();
  assert.deepEqual(all.map((x) => x.id), ["active", "recent", "mid", "old"]);

  const active = s.listSessions({ status: "active" });
  assert.deepEqual(active.map((x) => x.id), ["active"]);

  const since = s.listSessions({ since: "2026-09-05T00:00:00.000Z" });
  assert.deepEqual(since.map((x) => x.id), ["active", "recent", "mid"]);

  const limited = s.listSessions({ limit: 2 });
  assert.deepEqual(limited.map((x) => x.id), ["active", "recent"]);
});

test("storage: groupSessionsByRecency buckets by updatedAt", () => {
  const now = new Date(2026, 8, 22, 15, 0, 0); // local Sep 22 2026
  const sessions = [
    makeSession("older", new Date(2026, 8, 1, 10, 0).toISOString()),
    makeSession("last7", new Date(2026, 8, 16, 10, 0).toISOString()),
    makeSession("yesterday", new Date(2026, 8, 21, 10, 0).toISOString()),
    makeSession("today", new Date(2026, 8, 22, 10, 0).toISOString()),
  ];
  const groups = groupSessionsByRecency(sessions, now);
  assert.deepEqual(groups.map((g) => g.key), ["today", "yesterday", "last7", "older"]);
  assert.deepEqual(groups[0].sessions.map((x) => x.id), ["today"]);
  assert.deepEqual(groups[1].sessions.map((x) => x.id), ["yesterday"]);
  assert.deepEqual(groups[2].sessions.map((x) => x.id), ["last7"]);
  assert.deepEqual(groups[3].sessions.map((x) => x.id), ["older"]);
  assert.equal(groups[0].label, "Today");
  assert.equal(groups[1].label, "Yesterday");
  assert.equal(groups[2].label, "Previous 7 Days");
});

test("storage: groupSessionsByRecency sorts each group newest first", () => {
  const now = new Date(2026, 8, 22, 15, 0, 0);
  const sessions = [
    makeSession("today-early", new Date(2026, 8, 22, 8, 0).toISOString()),
    makeSession("today-late", new Date(2026, 8, 22, 14, 0).toISOString()),
  ];
  const groups = groupSessionsByRecency(sessions, now);
  assert.deepEqual(groups[0].sessions.map((x) => x.id), ["today-late", "today-early"]);
});

test("storage: no session file is created before start", () => {
  const s = createStorage(dir);
  assert.deepEqual(s.listSessions(), []);
  const files = readdirSync(join(dir, "data", "sessions")).filter((f) => f.endsWith(".json"));
  assert.equal(files.length, 0);
});

test("storage: fallbackTitle takes the first words of the topic prompt", () => {
  assert.equal(
    fallbackTitle("Mock tech interview for a junior backend engineer focusing on system design"),
    "Mock tech interview for a junior backend engineer",
  );
  assert.equal(fallbackTitle("   "), "Untitled session");
  assert.equal(fallbackTitle(""), "Untitled session");
});