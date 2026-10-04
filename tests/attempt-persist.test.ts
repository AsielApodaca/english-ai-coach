import { test } from "node:test";
import assert from "node:assert/strict";

import { persistAttempt, type AttemptStorage, type PersistAttemptParams } from "../src/lib/attempt-persist.ts";
import type { Evaluation } from "../src/lib/practice.ts";
import type { Profile, SessionFragmentV2, SessionQuestion, SessionV2 } from "../src/lib/storage.ts";

// ---------------------------------------------------------------------------
// Feature 117 — persistAttempt used to live inside server.ts and was only
// covered indirectly (through HTTP flows). Extracting it into
// lib/attempt-persist.ts made it unit-testable; this file is its executable
// contract: where an attempt lands (LAST question, named fragment or full
// answer), which profile writes it triggers, which no-ops are silent, and
// that a legacy v1 file (saveSession throwing) never breaks the caller.
// ---------------------------------------------------------------------------

const EVALUATION: Evaluation = {
  score: 60,
  verdict: "almost",
  matched: ["I", "handled"],
  missing: ["it"],
  extra: [],
  issues: [{ category: "grammar", message: "Add the article.", fix: "the issue" }],
  tips: ["Slow down."],
  next: false,
};

function makeFragment(id: string): SessionFragmentV2 {
  return { id, text: `text of ${id}`, attempts: [], passed: false };
}

function makeQuestion(q: string, fragmentIds: string[]): SessionQuestion {
  return { q, answer: "", fragments: fragmentIds.map(makeFragment), fullAttempt: null, eval: null };
}

function makeSession(id: string, questions: SessionQuestion[]): SessionV2 {
  const now = "2026-10-01T10:00:00.000Z";
  return {
    id,
    status: "active",
    createdAt: now,
    updatedAt: now,
    provider: "mock",
    title: "Title",
    config: {
      topicPrompt: "Config topic prompt",
      level: "B1",
      category: "free",
      accent: "en-US",
      phonemes: [],
      contextFiles: [],
      settingsSnapshot: { version: 1, overrides: {} },
    },
    questions,
  };
}

/** In-memory AttemptStorage double with call counters and a fail switch. */
function makeFakeStorage(sessions: SessionV2[] = []) {
  const profile: Profile = { level: "B1", categories: {}, weakErrors: {}, vocabGaps: [], recentTopics: [] };
  const calls = { loadSession: 0, saveSession: 0, loadProfile: 0, saveProfile: 0, loadAllSessions: 0 };
  let throwOnSave = false;
  const storage: AttemptStorage = {
    loadSession(id) {
      calls.loadSession++;
      return sessions.find((s) => s.id === id);
    },
    saveSession(session) {
      calls.saveSession++;
      if (throwOnSave) throw new Error("legacy v1 session file is read-only");
      const index = sessions.findIndex((s) => s.id === session.id);
      if (index === -1) sessions.push(session);
      else sessions[index] = session;
    },
    loadProfile() {
      calls.loadProfile++;
      return profile;
    },
    saveProfile() {
      calls.saveProfile++;
    },
    loadAllSessions() {
      calls.loadAllSessions++;
      return [...sessions];
    },
  };
  return {
    storage,
    profile,
    sessions,
    calls,
    /** Simulate a legacy v1 file / disk error on the next saveSession. */
    failOnSave() {
      throwOnSave = true;
    },
  };
}

function params(overrides: Partial<PersistAttemptParams> = {}): PersistAttemptParams {
  return { evaluation: EVALUATION, userText: "I handled it", target: "I handled it", ...overrides };
}

test("persistAttempt: without sessionId nothing is read, written or aggregated", () => {
  const fake = makeFakeStorage();
  persistAttempt(fake.storage, params());
  assert.deepEqual(fake.calls, { loadSession: 0, saveSession: 0, loadProfile: 0, saveProfile: 0, loadAllSessions: 0 });
});

test("persistAttempt: an unknown sessionId is a silent no-op", () => {
  const fake = makeFakeStorage([makeSession("known", [makeQuestion("q", ["f1"])])]);
  persistAttempt(fake.storage, params({ sessionId: "ghost" }));
  assert.equal(fake.calls.loadSession, 1);
  assert.equal(fake.calls.saveProfile, 0);
  assert.equal(fake.calls.saveSession, 0);
});

test("persistAttempt: the attempt lands on the LAST question's named fragment", () => {
  const session = makeSession("s1", [makeQuestion("first question", ["f1"]), makeQuestion("second question", ["f1", "f2"])]);
  const fake = makeFakeStorage([session]);
  const words = [
    { word: "I", status: "green" as const, startMs: 0, endMs: 120 },
    { word: "handled", status: "amber" as const },
  ];

  persistAttempt(fake.storage, params({ sessionId: "s1", fragmentId: "f1", score: 88, passed: true, words }));

  const lastQuestion = session.questions[1];
  const targetFragment = lastQuestion.fragments[0];
  assert.equal(targetFragment.attempts.length, 1);
  assert.equal(targetFragment.attempts[0].score, 88, "the align-score override wins over evaluation.score");
  assert.equal(targetFragment.attempts[0].text, "I handled it");
  assert.deepEqual(targetFragment.attempts[0].words, words);
  assert.equal(targetFragment.passed, true, "passed=true marks the fragment");
  assert.match(targetFragment.attempts[0].startedAt, /^\d{4}-\d{2}-\d{2}T/);

  // Older question / other fragment untouched (attempts target questions.at(-1)).
  assert.equal(session.questions[0].fragments[0].attempts.length, 0);
  assert.equal(lastQuestion.fragments[1].attempts.length, 0);

  // Profile re-aggregated once and persisted once; topic pushed to recents.
  assert.equal(fake.calls.saveProfile, 1);
  assert.equal(fake.calls.saveSession, 1);
  assert.equal(fake.calls.loadAllSessions, 1);
  assert.equal(fake.profile.recentTopics[0], "second question");
});

test("persistAttempt: a legacy fragment without an attempts array gets initialized (no crash)", () => {
  const session = makeSession("s1", [makeQuestion("q", ["f1"])]);
  // Simulate pre-105 data: the `attempts` field simply is not there.
  Reflect.deleteProperty(session.questions[0].fragments[0], "attempts");
  const fake = makeFakeStorage([session]);

  // Must not throw: computeStats (inside updateProfile) flat-maps `f.attempts`.
  persistAttempt(fake.storage, params({ sessionId: "s1", fragmentId: "f1" }));
  assert.equal(session.questions[0].fragments[0].attempts.length, 1);
  assert.equal(fake.calls.saveProfile, 1);
});

test("persistAttempt: `passed` overrides evaluation.next in both directions", () => {
  const session = makeSession("s1", [makeQuestion("q", ["f1"])]);
  const fake = makeFakeStorage([session]);

  // evaluation.next = false but passed = true → marked as passed.
  persistAttempt(fake.storage, params({ sessionId: "s1", fragmentId: "f1", passed: true }));
  assert.equal(session.questions[0].fragments[0].passed, true);

  // evaluation.next = true alone must NOT mark a fragment as passed when the
  // caller passed `passed: false` — the override decides (fresh fragment).
  const optimistic = { ...EVALUATION, next: true };
  const otherSession = makeSession("s2", [makeQuestion("q", ["g1"])]);
  const otherFake = makeFakeStorage([otherSession]);
  persistAttempt(otherFake.storage, params({ evaluation: optimistic, sessionId: "s2", fragmentId: "g1", passed: false }));
  assert.equal(otherSession.questions[0].fragments[0].passed, false);
});

test("persistAttempt: fragment path with no/unknown fragmentId persists nothing", () => {
  const session = makeSession("s1", [makeQuestion("q", ["f1"])]);
  const fake = makeFakeStorage([session]);

  persistAttempt(fake.storage, params({ sessionId: "s1" }));
  assert.equal(fake.calls.saveProfile, 0);
  assert.equal(fake.calls.saveSession, 0);

  persistAttempt(fake.storage, params({ sessionId: "s1", fragmentId: "nope" }));
  assert.equal(fake.calls.saveProfile, 0);
  assert.equal(fake.calls.saveSession, 0);
});

test("persistAttempt: full=true writes fullAttempt + question.eval (score stays evaluation.score)", () => {
  const session = makeSession("s1", [makeQuestion("q", ["f1"])]);
  const fake = makeFakeStorage([session]);
  const words = [{ word: "I", status: "green" as const }];

  persistAttempt(fake.storage, params({ sessionId: "s1", full: true, score: 77, passed: true, words }));

  const question = session.questions[0];
  assert.ok(question.fullAttempt);
  assert.equal(question.fullAttempt.text, "I handled it");
  assert.equal(question.fullAttempt.score, 77, "fullAttempt carries the align-score override");
  assert.equal(question.fullAttempt.durationMs, 0);
  assert.deepEqual(question.fullAttempt.words, words);

  assert.ok(question.eval);
  assert.equal(question.eval.score, EVALUATION.score, "the consolidated eval keeps the evaluation score");
  assert.equal(question.eval.verdict, EVALUATION.verdict);
  assert.equal(question.eval.next, true, "passed=true drives eval.next");
  assert.deepEqual(question.eval.issues, EVALUATION.issues);
  assert.deepEqual(question.eval.tips, EVALUATION.tips);
  assert.equal(fake.calls.saveProfile, 1);
});

test("persistAttempt: without `passed`, eval.next falls back to evaluation.next", () => {
  const session = makeSession("s1", [makeQuestion("q", ["f1"])]);
  const fake = makeFakeStorage([session]);

  persistAttempt(fake.storage, params({ sessionId: "s1", full: true }));
  assert.equal(session.questions[0].eval?.next, EVALUATION.next);

  const optimistic = { ...EVALUATION, next: true };
  persistAttempt(fake.storage, params({ evaluation: optimistic, sessionId: "s1", full: true }));
  assert.equal(session.questions[0].eval?.next, true);
});

test("persistAttempt: without a score override the attempt uses evaluation.score", () => {
  const session = makeSession("s1", [makeQuestion("q", ["f1"])]);
  const fake = makeFakeStorage([session]);

  persistAttempt(fake.storage, params({ sessionId: "s1", fragmentId: "f1" }));
  assert.equal(session.questions[0].fragments[0].attempts[0].score, EVALUATION.score);
});

test("persistAttempt: recentTopics is deduped (the topic moves to the front) and capped at 12", () => {
  const session = makeSession("s1", [makeQuestion("The topic", ["f1"])]);
  const fake = makeFakeStorage([session]);
  // Defensive over-cap input (14): a stale duplicate of the current topic plus
  // 12 unrelated olds — the write must dedupe, unshift and slice to 12.
  fake.profile.recentTopics = ["The topic", "The topic", ...Array.from({ length: 12 }, (_, i) => `old-${i}`)];
  assert.equal(fake.profile.recentTopics.length, 14);

  persistAttempt(fake.storage, params({ sessionId: "s1", fragmentId: "f1" }));

  const recents = fake.profile.recentTopics;
  assert.equal(recents.length, 12, "capped at 12 after dedupe");
  assert.equal(recents[0], "The topic", "the current topic leads");
  assert.equal(recents.filter((t) => t === "The topic").length, 1, "the stale duplicate was removed");
  assert.equal(recents.includes("old-11"), false, "the oldest entry fell off the cap");
});

test("persistAttempt: a saveSession failure (legacy v1 file) is swallowed, the profile still lands", () => {
  const session = makeSession("s1", [makeQuestion("q", ["f1"])]);
  const fake = makeFakeStorage([session]);
  fake.failOnSave();

  // The contract: never throws (the HTTP response must not break).
  persistAttempt(fake.storage, params({ sessionId: "s1", fragmentId: "f1" }));

  assert.equal(fake.calls.saveSession, 1, "the write was attempted");
  assert.equal(fake.calls.saveProfile, 1, "profile aggregation happened before the save");
  // The in-memory session (what the caller would re-read) carries the attempt.
  assert.equal(session.questions[0].fragments[0].attempts.length, 1);
});
