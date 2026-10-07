import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candidate } from "../src/lib/practice/practice.ts";
import { buildLearnerMemory, computeStats, deriveSessionTitle, sessionTopics, TOPIC_CHARS } from "../src/lib/practice/learner.ts";
import type { Profile, SessionV2 } from "../src/lib/session/storage.ts";

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

function failing(id: string): Candidate {
  return {
    id: id as never,
    async available() {
      return true;
    },
    async complete() {
      throw new Error("boom");
    },
  };
}

test("deriveSessionTitle: uses the LLM title when available", async () => {
  const { title, provider } = await deriveSessionTitle(
    [fake("amber", '{"title":"Junior SWE First Interview"}')],
    "Mock tech interview for a junior backend engineer focusing on system design",
  );
  assert.equal(title, "Junior SWE First Interview");
  assert.equal(provider, "amber");
});

test("deriveSessionTitle: falls back to the first words of the topic prompt", async () => {
  const { title, provider } = await deriveSessionTitle(
    [failing("amber"), failing("gemini")],
    "Mock tech interview for a junior backend engineer focusing on system design",
  );
  assert.equal(title, "Mock tech interview for a junior backend engineer");
  assert.equal(provider, "local");
});

test("deriveSessionTitle: ignores a non-string LLM title", async () => {
  const { title, provider } = await deriveSessionTitle(
    [fake("amber", '{"title": 42}')],
    "Mock tech interview for a junior backend engineer focusing on system design",
  );
  assert.equal(title, "Mock tech interview for a junior backend engineer");
  assert.equal(provider, "local");
});

// --- computeStats / vocabGaps -----------------------------------------------

/** One session with a single fragment whose attempts carry the given red words. */
function sessionWithRedWords(redWords: string[]): SessionV2 {
  return {
    id: "s1",
    status: "active",
    createdAt: "2026-09-30T00:00:00.000Z",
    updatedAt: "2026-09-30T00:00:00.000Z",
    config: {
      topicPrompt: "Describe a project",
      level: "B2",
      category: "general",
      accent: "us",
      phonemes: [],
      contextFiles: [],
      settingsSnapshot: { version: 1, overrides: {} },
    },
    provider: "amber",
    questions: [
      {
        q: "Describe a project",
        answer: "I worked on a project.",
        fragments: [
          {
            id: "f1",
            text: "I worked on a project.",
            attempts: [
              {
                text: "…",
                words: redWords.map((word) => ({ word, status: "red" as const })),
                score: 60,
                startedAt: "2026-09-30T00:00:00.000Z",
                durationMs: 10,
              },
            ],
            passed: false,
          },
        ],
        fullAttempt: null,
        eval: null,
      },
    ],
    title: "t",
  };
}

test("computeStats: vocabGaps normalize red words — no annotations, no punctuation", () => {
  const stats = computeStats({} as Profile, [
    sessionWithRedWords(["[BLANK_AUDIO]", "[BLANK_AUDIO]", "coverage.", "coverage."]),
  ]);
  assert.deepEqual(stats.vocabGaps, ["coverage"]);
  assert.ok(!stats.vocabGaps.some((w) => w.includes("blank_audio")), `vocabGaps=${stats.vocabGaps}`);
  assert.ok(!stats.vocabGaps.some((w) => w.includes(".")), `vocabGaps=${stats.vocabGaps}`);
});

// --- sessionTopics / buildLearnerMemory -------------------------------------
// Regression (bug: previous-session context leaked into new sessions): the
// topics re-injected as LEARNER MEMORY must come from the user's own prompts,
// be small, and be framed as history so a document-derived detail from an
// earlier session never steers a new one.

function session(id: string, topicPrompt: string, updatedAt: string, question = `derived question ${id}`): SessionV2 {
  return {
    id,
    status: "active",
    createdAt: updatedAt,
    updatedAt,
    provider: "amber",
    title: id,
    config: {
      topicPrompt,
      level: "B2",
      category: "free",
      accent: "us",
      phonemes: [],
      contextFiles: [],
      settingsSnapshot: { version: 1, overrides: {} },
    },
    questions: [{ q: question, answer: "", fragments: [], fullAttempt: null, eval: null }],
  };
}

function profileWithTopics(recentTopics: string[]): Profile {
  return { level: "B2", categories: {}, weakErrors: {}, vocabGaps: [], recentTopics };
}

test("sessionTopics: newest first, capped at 10, topicPrompt only (never the LLM question)", () => {
  const sessions = Array.from({ length: 12 }, (_, i) =>
    session(`s${i}`, `topic ${i}`, `2026-10-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`),
  );
  const topics = sessionTopics(sessions);
  assert.equal(topics.length, 10, "capped at 10");
  assert.equal(topics[0], "topic 11", "newest session first regardless of input order");
  assert.equal(topics[9], "topic 2");
  assert.ok(
    !topics.some((t) => t.startsWith("derived question")),
    "the LLM-generated question must never be used as a topic",
  );
});

test("sessionTopics: blank topicPrompts are skipped and long ones truncated", () => {
  const long = `x ${"y".repeat(TOPIC_CHARS * 3)}`;
  const topics = sessionTopics([
    session("s1", long, "2026-10-02T00:00:00.000Z"),
    session("s2", "   ", "2026-10-01T00:00:00.000Z"),
  ]);
  assert.equal(topics.length, 1, "blank prompts are dropped");
  assert.equal(topics[0].length, TOPIC_CHARS + 1, "truncated to TOPIC_CHARS + ellipsis");
  assert.ok(topics[0].endsWith("…"));
});

test("buildLearnerMemory: recent topics are capped, truncated and framed as history", () => {
  const recent = Array.from({ length: 8 }, (_, i) => `topic number ${i} ${"z".repeat(TOPIC_CHARS * 4)}`);
  const memory = buildLearnerMemory(profileWithTopics(recent), []);

  assert.ok(memory.includes("background only"), "topics must be framed as history");
  assert.ok(memory.includes("Do not repeat"), "the memory must forbid reusing past topics");

  const mentioned = recent.filter((t) => memory.includes(t.slice(0, 40)));
  assert.equal(mentioned.length, 5, "only the 5 newest topics reach the prompt");
  assert.ok(!memory.includes("z".repeat(TOPIC_CHARS)), "every topic is truncated to TOPIC_CHARS");
});

test("buildLearnerMemory: no Recent topics line when the profile has none", () => {
  const memory = buildLearnerMemory(profileWithTopics([]), []);
  assert.ok(!memory.includes("Recent topics"), memory);
});