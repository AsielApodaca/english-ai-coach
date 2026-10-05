import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candidate } from "../src/lib/practice.ts";
import { computeStats, deriveSessionTitle } from "../src/lib/learner.ts";
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