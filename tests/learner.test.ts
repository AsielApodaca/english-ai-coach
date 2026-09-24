import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candidate } from "../src/lib/practice.ts";
import { deriveSessionTitle } from "../src/lib/learner.ts";

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