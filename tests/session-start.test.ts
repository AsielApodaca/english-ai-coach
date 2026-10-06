import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSessionStartRequest } from "../src/lib/session/session-start.ts";
import { createStorage, DEFAULT_ACCENT, type Profile } from "../src/lib/session/storage.ts";
import { ProviderError } from "../src/lib/providers/index.ts";
import type { Candidate } from "../src/lib/practice/practice.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FAKE_FIRST = `{"question":"Tell me about a time you led a difficult project.","fragments":[{"id":"f1","stage":"Opening","text":"Last year I led a project with a very tight deadline."},{"id":"f2","stage":"Main point","text":"I split the work into small tasks and tracked progress daily."},{"id":"f3","stage":"Example","text":"We shipped two days early and the client was thrilled."}]}`;

const FAKE_TITLE = `{"title":"Leading a Difficult Project"}`;

/** Fake provider that returns a fixed reply (or a function of the messages). */
function fake(id: string, reply: string | ((messages: unknown[]) => string)): Candidate {
  return {
    id: id as never,
    async available() {
      return true;
    },
    async complete(messages: unknown[]) {
      if (typeof reply === "function") return reply(messages);
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

/** Counter-based fake: first call returns the first question, then the title. */
function scriptedFake(calls: string[]): { candidate: Candidate; messages: unknown[][] } {
  const messages: unknown[][] = [];
  let i = 0;
  return {
    messages,
    candidate: {
      id: "amber" as never,
      async available() {
        return true;
      },
      async complete(msgs: unknown[]) {
        messages.push(msgs);
        return calls[Math.min(i++, calls.length - 1)];
      },
    },
  };
}

function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    level: "B2",
    categories: {},
    weakErrors: {},
    vocabGaps: [],
    recentTopics: [],
    ...overrides,
  };
}

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engcoach-start-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sessionFiles(): string[] {
  return readdirSync(join(dir, "data", "sessions")).filter((f) => f.endsWith(".json"));
}

// ---------------------------------------------------------------------------
// Validation (400) — no session is created
// ---------------------------------------------------------------------------

test("session/start: missing topicPrompt → 400", async () => {
  const s = createStorage(dir);
  const res = await handleSessionStartRequest(s, [fake("amber", FAKE_FIRST)], { level: "B2" });
  assert.equal(res.status, 400);
  assert.match(res.json.error as string, /topicPrompt/);
  assert.deepEqual(sessionFiles(), []);
});

test("session/start: blank topicPrompt → 400", async () => {
  const s = createStorage(dir);
  const res = await handleSessionStartRequest(s, [fake("amber", FAKE_FIRST)], { topicPrompt: "   ", level: "B2" });
  assert.equal(res.status, 400);
  assert.deepEqual(sessionFiles(), []);
});

test("session/start: invalid level → 400", async () => {
  const s = createStorage(dir);
  const res = await handleSessionStartRequest(s, [fake("amber", FAKE_FIRST)], { topicPrompt: "Role", level: "C3" });
  assert.equal(res.status, 400);
  assert.match(res.json.error as string, /level/i);
  assert.deepEqual(sessionFiles(), []);
});

test("session/start: missing level → 400", async () => {
  const s = createStorage(dir);
  const res = await handleSessionStartRequest(s, [fake("amber", FAKE_FIRST)], { topicPrompt: "Role" });
  assert.equal(res.status, 400);
  assert.deepEqual(sessionFiles(), []);
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

test("session/start: creates a v2 session and persists the first question", async () => {
  const s = createStorage(dir);
  const { candidate } = scriptedFake([FAKE_FIRST, FAKE_TITLE]);
  const res = await handleSessionStartRequest(s, [candidate], {
    topicPrompt: "  Simula ser un Engineering Manager de Google.  ",
    level: "C1",
    accent: "Received Pronunciation (UK)",
    focusPhonemes: ["θ", "ð"],
  });

  assert.equal(res.status, 200);
  const { sessionId, firstQuestion } = res.json as { sessionId: string; firstQuestion: { q: string; answer: string; fragments: unknown[] } };
  assert.ok(sessionId.length > 0);
  assert.equal(firstQuestion.q, "Tell me about a time you led a difficult project.");
  assert.equal(firstQuestion.fragments.length, 3);
  assert.ok(firstQuestion.answer.includes("Last year I led a project"));

  const session = s.loadSession(sessionId);
  assert.ok(session);
  assert.equal(session.status, "active");
  assert.equal(session.config.topicPrompt, "Simula ser un Engineering Manager de Google.");
  assert.equal(session.config.level, "C1");
  assert.equal(session.config.category, "free");
  assert.equal(session.config.accent, "Received Pronunciation (UK)");
  assert.deepEqual(session.config.phonemes, ["θ", "ð"]);
  assert.deepEqual(session.config.contextFiles, []);
  assert.equal(session.title, "Leading a Difficult Project");
  assert.equal(session.provider, "amber");
  assert.equal(session.questions.length, 1);
  assert.equal(session.questions[0].q, firstQuestion.q);
  assert.equal(session.questions[0].answer, firstQuestion.answer);
  assert.equal(session.questions[0].fragments.length, 3);
  assert.equal(session.questions[0].fullAttempt, null);
  assert.equal(session.questions[0].eval, null);
});

test("session/start: defaults accent to General American (US)", async () => {
  const s = createStorage(dir);
  const { candidate } = scriptedFake([FAKE_FIRST, FAKE_TITLE]);
  const res = await handleSessionStartRequest(s, [candidate], { topicPrompt: "Role", level: "B2" });
  assert.equal(res.status, 200);
  const { sessionId } = res.json as { sessionId: string };
  assert.equal(s.loadSession(sessionId)!.config.accent, DEFAULT_ACCENT);
});

test("session/start: learner memory and DOCUMENT CONTEXT reach the LLM call", async () => {
  const s = createStorage(dir);
  writeFileSync(
    join(dir, "data", "profile.json"),
    JSON.stringify(makeProfile({ level: "B1", weakErrors: { grammar: 3 }, vocabGaps: ["deadline"] })),
    "utf8",
  );
  const textRef = s.saveContextText("draft", { name: "job.md", size: 9, kind: "md" }, "the job spec");
  const { candidate, messages } = scriptedFake([FAKE_FIRST, FAKE_TITLE]);
  const res = await handleSessionStartRequest(s, [candidate], {
    topicPrompt: "Role",
    level: "B2",
    contextFiles: [{ name: "job.md", size: 9, kind: "md", textRef }],
  });

  assert.equal(res.status, 200);
  assert.equal(messages.length, 2); // first question + title
  const first = messages[0] as Array<{ role: string; content: string }>;
  const system = first.find((m) => m.role === "system")?.content ?? "";
  const user = first.find((m) => m.role === "user")?.content ?? "";
  assert.ok(system.includes("ROLE INSTRUCTION"), "role instruction must be the system persona");
  assert.ok(system.includes("Role"), "topic prompt must be the role instruction");
  assert.ok(user.includes("LEARNER MEMORY"), "learner memory must be present");
  assert.ok(user.includes("Estimated level: B1"), "learner memory must reflect the profile");
  assert.ok(user.includes("DOCUMENT CONTEXT"), "context files must be injected");
  assert.ok(user.includes("the job spec"), "extracted text must be injected");
  assert.ok(user.includes("never JSON"), "the document must be marked as data, not prompt syntax");

  // context files are snapshotted into the session config
  const { sessionId } = res.json as { sessionId: string };
  assert.deepEqual(s.loadSession(sessionId)!.config.contextFiles, [
    { name: "job.md", size: 9, kind: "md", textRef },
  ]);
});

test("session/start: missing context text is skipped defensively", async () => {
  const s = createStorage(dir);
  const { candidate } = scriptedFake([FAKE_FIRST, FAKE_TITLE]);
  const res = await handleSessionStartRequest(s, [candidate], {
    topicPrompt: "Role",
    level: "B2",
    contextFiles: [{ name: "gone.pdf", size: 5, kind: "pdf", textRef: "pdf-missing.txt" }],
  });
  assert.equal(res.status, 200);
  const { sessionId } = res.json as { sessionId: string };
  assert.deepEqual(s.loadSession(sessionId)!.config.contextFiles, []);
});

// ---------------------------------------------------------------------------
// LLM failure (502) — no session is created
// ---------------------------------------------------------------------------

test("session/start: LLM failure → 502 and no session file", async () => {
  const s = createStorage(dir);
  const res = await handleSessionStartRequest(s, [failing("amber"), failing("gemini")], {
    topicPrompt: "Role",
    level: "B2",
  });
  assert.equal(res.status, 502);
  assert.ok((res.json.error as string).length > 0);
  assert.deepEqual(sessionFiles(), []);
});

// ---------------------------------------------------------------------------
// Feature 105 fix: fragments are born with attempts[] and passed=false
// (consumers persistAttempt/computeStats assume both exist from birth)
// ---------------------------------------------------------------------------

test("session/start: fragments are born with attempts: [] and passed: false", async () => {
  const s = createStorage(dir);
  const { candidate } = scriptedFake([FAKE_FIRST, FAKE_TITLE]);
  const res = await handleSessionStartRequest(s, [candidate], { topicPrompt: "Role", level: "B2" });
  assert.equal(res.status, 200);

  const { sessionId } = res.json as { sessionId: string };
  const session = s.loadSession(sessionId)!;
  const fragments = session.questions[0].fragments;
  assert.equal(fragments.length, 3);
  for (const fragment of fragments) {
    assert.deepEqual(fragment.attempts, []);
    assert.equal(fragment.passed, false);
  }
});

// ---------------------------------------------------------------------------
// Degenerate first-question replies — regression (feature 104): a collapsed
// fragments array (duplicate JSON keys) and an empty question used to be
// persisted as a valid session, producing a one-fragment "model answer".
// ---------------------------------------------------------------------------

/** The reply that shipped the bug: 5 items folded into one `f5` fragment. */
const COLLAPSED_FIRST =
  `{"question":"Can you describe a difficult problem you solved at Zenda Logistics?",` +
  `"fragments":[{"id":"f1","stage":"Opening","text":"First line.","id":"f5","stage":"Closing",` +
  `"text":"Now our data is reliable and ready for artificial intelligence models."}]}`;

const EMPTY_QUESTION_FIRST = `{"question":"","fragments":[{"id":"f1","stage":"Opening","text":"First line."},{"id":"f2","stage":"Detail","text":"Second line."},{"id":"f3","stage":"Closing","text":"Third line."}]}`;

test("session/start: a collapsed fragments array → 502 and NO session is created", async () => {
  const s = createStorage(dir);
  const res = await handleSessionStartRequest(s, [fake("amber", COLLAPSED_FIRST)], {
    topicPrompt: "Entrevista del resume adjunto",
    level: "B2",
  });
  assert.equal(res.status, 502);
  assert.match(res.json.error as string, /Duplicate key "id"/);
  assert.deepEqual(sessionFiles(), []);
});

test("session/start: an empty question → 502 and NO session is created", async () => {
  const s = createStorage(dir);
  const res = await handleSessionStartRequest(s, [fake("amber", EMPTY_QUESTION_FIRST)], {
    topicPrompt: "Role",
    level: "B2",
  });
  assert.equal(res.status, 502);
  assert.match(res.json.error as string, /empty question/);
  assert.deepEqual(sessionFiles(), []);
});

test("session/start: a single-fragment answer → 502 and NO session is created", async () => {
  const s = createStorage(dir);
  const oneFragment = `{"question":"Tell me about your last internship.","fragments":[{"id":"f5","stage":"Closing","text":"Now our data is reliable."}]}`;
  const res = await handleSessionStartRequest(s, [fake("amber", oneFragment)], { topicPrompt: "Role", level: "B2" });
  assert.equal(res.status, 502);
  assert.match(res.json.error as string, /usable fragments \(minimum 3\)/);
  assert.deepEqual(sessionFiles(), []);
});