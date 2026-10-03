import { test } from "node:test";
import assert from "node:assert/strict";
import { chatJSON, completeWithFallback, ProviderError } from "../src/lib/providers/index.ts";
import type { Candidate } from "../src/lib/practice.ts";
import { generatePracticeSet, evaluateFragment, evaluateFragmentDeterministic, mergeLLMFeedback, type LLMFeedback, type WordMatch } from "../src/lib/practice.ts";

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

test("completeWithFallback: falls back to the next provider on failure", async () => {
  const result = await completeWithFallback([failing("amber"), fake("gemini", "ok"), fake("ollama", "ignored")], [{ role: "user", content: "hi" }]);
  assert.equal(result.provider, "gemini");
  assert.equal(result.text, "ok");
});

test("completeWithFallback: uses the first working provider", async () => {
  const result = await completeWithFallback([fake("amber", "from zen"), fake("gemini", "from gemini")], [{ role: "user", content: "hi" }]);
  assert.equal(result.provider, "amber");
});

test("completeWithFallback: throws combined error when all fail", async () => {
  await assert.rejects(
    () => completeWithFallback([failing("amber"), failing("gemini")], [{ role: "user", content: "hi" }]),
    /All LLM providers failed/,
  );
});

test("completeWithFallback: a stalled provider times out and falls back", async () => {
  const pre = process.env.LLM_TIMEOUT_MS;
  process.env.LLM_TIMEOUT_MS = "80";
  try {
    const hungry = {
      id: "amber" as never,
      async available() {
        return true;
      },
      async complete(_messages: unknown[], options: { signal?: AbortSignal }) {
        // Mirrors the real providers, which reject when fetch aborts on signal.
        return new Promise<string>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new ProviderError("aborted by timeout", true)),
            { once: true },
          );
        });
      },
    };
    const result = await completeWithFallback([hungry, fake("gemini", "fast pip")], [{ role: "user", content: "hi" }]);
    assert.equal(result.provider, "gemini");
    assert.equal(result.text, "fast pip");
  } finally {
    delete process.env.LLM_TIMEOUT_MS;
    if (pre !== undefined) process.env.LLM_TIMEOUT_MS = pre;
  }
});

test("chatJSON: extracts structured data from response with prose", async () => {
  const { data, provider } = await chatJSON<{ word: string }>([fake("amber", 'Here you go: ```json\n{"word": "situation"}\n```')], {
    system: "be strict",
    user: "task",
  });
  assert.equal(provider, "amber");
  assert.equal(data.word, "situation");
});

const FAKE_SET = `{"question":"Tell me about a difficult situation you handled.","context":"Use past tense and STAR.","fragments":[{"id":"f1","stage":"Situation","text":"Once in this company I had a difficult situation."},{"id":"f2","stage":"Action","text":"I analyzed the problem carefully and asked my team for support."}]}`;

test("generatePracticeSet: builds fragments from LLM JSON", async () => {
  const { set, provider } = await generatePracticeSet([fake("amber", FAKE_SET)], {
    category: "star",
    level: "B2",
    learnerMemory: "",
  });
  assert.equal(provider, "amber");
  assert.equal(set.fragments.length, 2);
  assert.equal(set.fragments[0].stage, "Situation");
  assert.ok(set.fragments[0].text.length > 0);
});

const FAKE_EVAL = `{"issues":[{"category":"grammar","message":"Add the","fix":"Use \\"the problem\\""}],"tips":["Slow down"],"naturalness":72}`;

test("evaluateFragment: blends deterministic match with LLM naturalness", async () => {
  const target = "Once in this company I had a difficult situation.";
  const user = "Once in this company I had a difficult situation.";
  const { evaluation, provider } = await evaluateFragment([fake("amber", FAKE_EVAL)], {
    target,
    userText: user,
    question: "q",
    level: "B2",
  });
  assert.equal(provider, "amber");
  assert.equal(evaluation.missing.length, 0);
  assert.ok(evaluation.score >= 70);
  assert.equal(evaluation.issues[0].category, "grammar");
});

test("evaluateFragment: still returns deterministic feedback when LLM fails", async () => {
  const target = "Once in this company I had a difficult situation.";
  const user = "Once in this company I had a situation."; // misses "difficult"
  const { evaluation } = await evaluateFragment([failing("amber"), failing("gemini")], {
    target,
    userText: user,
    question: "q",
    level: "B2",
  });
  assert.ok(evaluation.missing.includes("difficult"));
  assert.ok(evaluation.score < 100);
  assert.ok(["retry", "almost", "great"].includes(evaluation.verdict));
});

test("evaluateFragment: invented words are reported as an issue and lower the score", async () => {
  const target = "I handled the situation well.";
  const user = "I like chocolate, I handled the situation well.";
  const { evaluation } = await evaluateFragment([failing("amber"), failing("gemini")], {
    target,
    userText: user,
    question: "q",
    level: "B2",
  });
  assert.deepEqual(evaluation.missing, []);
  const issue = evaluation.issues.find((i) => i.category === "other");
  assert.ok(issue, `issues=${JSON.stringify(evaluation.issues)}`);
  assert.ok(issue.message.includes("like") && issue.message.includes("chocolate"));
  // 3 spoken words outside the fragment subtract from the 5 matched → 40.
  assert.deepEqual(evaluation.extra, ["i", "like", "chocolate"]);
  assert.equal(evaluation.score, 40);
  assert.equal(evaluation.verdict, "retry");
  assert.equal(evaluation.next, false);
});

// ---------------------------------------------------------------------------
// Feature 116 — the split: LLM-free evaluation + the merge it feeds
// ---------------------------------------------------------------------------

test("evaluateFragmentDeterministic: lexical score and derived issues, no LLM involved", () => {
  const perfect = evaluateFragmentDeterministic({
    target: "I handled the situation well.",
    userText: "I handled the situation well.",
  });
  assert.equal(perfect.evaluation.score, 100);
  assert.equal(perfect.evaluation.verdict, "great");
  assert.equal(perfect.evaluation.next, true);
  assert.deepEqual(perfect.evaluation.issues, [], "a clean repetition derives no issues");

  const imperfect = evaluateFragmentDeterministic({
    target: "I handled the situation well.",
    userText: "I like chocolate, I handled the situation.", // extra words + missing "well"
  });
  // Derived issues (no quotes for added words) come straight from the match.
  const added = imperfect.evaluation.issues.find((i) => i.category === "other");
  assert.ok(added && added.message.includes("like") && added.message.includes("chocolate"));
  const missing = imperfect.evaluation.issues.find((i) => i.category === "pronunciation");
  assert.ok(missing && missing.message.includes("well"));
  assert.ok(imperfect.evaluation.score < 100);
});

test("evaluateFragmentDeterministic: equals evaluateFragment when every provider is down", async () => {
  const params = { target: "I handled the situation well.", userText: "I handled the situation." };
  const { evaluation } = await evaluateFragment([failing("amber"), failing("gemini")], { ...params, question: "q", level: "B2" });
  assert.deepEqual(evaluateFragmentDeterministic(params).evaluation, evaluation);
});

test("mergeLLMFeedback: naturalness blends 0.75·lexical + 0.25·naturalness", () => {
  const lexical: WordMatch = { score: 100, matched: ["a"], missing: [], extra: [] };
  const merged = mergeLLMFeedback(lexical, { issues: [], tips: ["Slow down"], naturalness: 60 } satisfies LLMFeedback);
  assert.equal(merged.score, 90);
  assert.equal(merged.verdict, "great");
  assert.equal(merged.next, true);
});

test("mergeLLMFeedback: missing naturalness falls back to the lexical score", () => {
  const lexical: WordMatch = { score: 40, matched: ["a"], missing: ["b"], extra: [] };
  const merged = mergeLLMFeedback(lexical, { issues: [], tips: [] });
  assert.equal(merged.score, 40, "a dead LLM scores exactly like the fast path");
  assert.equal(merged.verdict, "retry");
  assert.equal(merged.next, false);
});

test("mergeLLMFeedback: derived issues first, then the LLM's, capped at 5", () => {
  const lexical: WordMatch = { score: 40, matched: ["a"], missing: ["b"], extra: ["c"] };
  const llmIssues = [1, 2, 3, 4, 5, 6].map((n) => ({ category: "other" as const, message: `issue ${n}`, fix: `fix ${n}` }));
  const merged = mergeLLMFeedback(lexical, { issues: llmIssues, tips: [], naturalness: 40 });
  assert.equal(merged.issues.length, 5);
  // Derived: the added word (no quotes → never forced amber) and the missing one.
  assert.match(merged.issues[0].message, /added words.*c/i);
  assert.match(merged.issues[1].message, /Missing word/);
  assert.equal(merged.issues[2].message, "issue 1");
  assert.deepEqual(merged.missing, ["b"]);
  assert.deepEqual(merged.extra, ["c"]);
});