import { test } from "node:test";
import assert from "node:assert/strict";

import { createMockProvider } from "../src/lib/providers/mock.ts";
import { extractJSON } from "../src/lib/providers/index.ts";
import type { ChatMessage } from "../src/lib/providers/types.ts";

// ---------------------------------------------------------------------------
// Feature 117 — specification tests for the MOCK_LLM provider: it must be
// pure (always available, canned JSON chosen from the system prompt, fully
// deterministic) and must NEVER touch the network — asserted by mocking fetch
// and requiring zero calls.
// ---------------------------------------------------------------------------

function system(content: string): ChatMessage[] {
  return [
    { role: "system", content },
    { role: "user", content: "go" },
  ];
}

test("available(): always true, credentials are irrelevant", async () => {
  assert.equal(await createMockProvider().available(), true);
});

test("complete(): canned payloads match the schema of each call site", async () => {
  const mock = createMockProvider();

  // Title generation (session/save).
  const title = extractJSON<{ title: string }>(await mock.complete(system("Summarize the user's role instruction")));
  assert.equal(typeof title.title, "string");

  // Free-text evaluation (evaluateFragment / refine).
  const evaluation = extractJSON<{ issues: unknown[]; tips: string[]; naturalness: number }>(
    await mock.complete(system("Evaluate only what was actually said")),
  );
  assert.ok(Array.isArray(evaluation.issues));
  assert.ok(evaluation.tips.length > 0);
  assert.equal(typeof evaluation.naturalness, "number");

  // Next-step suggestion (buildNextStep).
  const nextStep = extractJSON<{ focus: string; topic: string; why: string; targetLevel: string }>(
    await mock.complete(system("Suggest the next move to reach conversational fluency")),
  );
  assert.equal(typeof nextStep.focus, "string");
  assert.equal(nextStep.targetLevel, "B2");

  // Practice-set generation (generatePracticeSet).
  const set = extractJSON<{ question: string; context: string; fragments: { id: string; stage: string; text: string }[] }>(
    await mock.complete(system("You create interview/practice answers")),
  );
  assert.ok(set.context.length > 0);
  assert.ok(set.fragments.length >= 4);

  // First/next question generation (session-start, continuous) — default branch.
  const first = extractJSON<{ question: string; fragments: { id: string }[] }>(
    await mock.complete(system("Generate the FIRST question of a practice session.")),
  );
  assert.ok(first.question.length > 0);
  assert.ok(first.fragments.length > 0);
});

test("complete(): deterministic — the same messages always yield the same reply", async () => {
  const mock = createMockProvider();
  const msgs = system("You create interview/practice answers");
  const a = await mock.complete(msgs);
  const b = await mock.complete(msgs);
  assert.equal(a, b);
});

test("complete(): never touches the network", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response("{}"));
  const mock = createMockProvider();
  await mock.complete(system("Generate the FIRST question of a practice session."));
  assert.equal(fetchMock.mock.callCount(), 0);
});
