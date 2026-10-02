import { test } from "node:test";
import assert from "node:assert/strict";

import { warmProviders, warmupEnabled, type CompleteOptions, type ChatMessage, type Provider, type ProviderId } from "../src/lib/providers/index.ts";

// ---------------------------------------------------------------------------
// Helpers & fixtures
// ---------------------------------------------------------------------------

interface FakeOptions {
  /** Recorded warm calls: provider id + the arguments it was called with. */
  calls: { id: string; messages: ChatMessage[]; options: CompleteOptions | undefined }[];
  /** When true, `complete` throws (a provider Ollama cannot reach). */
  fail?: boolean;
}

/** Fake provider that records its warm calls (and optionally fails). */
function fakeProvider(id: ProviderId, fake: FakeOptions): Provider {
  return {
    id,
    name: `fake ${id}`,
    async available() {
      return true;
    },
    async complete(messages: ChatMessage[], options?: CompleteOptions) {
      fake.calls.push({ id, messages, options });
      if (fake.fail) throw new Error(`${id} unavailable`);
      return "ok";
    },
  };
}

// ---------------------------------------------------------------------------
// warmProviders
// ---------------------------------------------------------------------------

test("warmProviders targets only ollama/ollama-fast and reports per-id results", async () => {
  const calls: FakeOptions["calls"] = [];
  const providers: Provider[] = [
    fakeProvider("gemini", { calls }),
    fakeProvider("cloudflare", { calls }),
    fakeProvider("mock", { calls }),
    fakeProvider("ollama", { calls }),
    fakeProvider("ollama-fast", { calls, fail: true }),
  ];

  const results = await warmProviders(providers);

  // Filtering: remote/canned providers are never touched.
  const called = calls.map((c) => c.id).sort();
  assert.deepEqual(called, ["ollama", "ollama-fast"]);

  // Per-id results: success → true, throwing provider → false, no extra keys.
  assert.deepEqual(results, { ollama: true, "ollama-fast": false });

  // The warm call itself: 1-token completion with a trivial user message.
  for (const call of calls) {
    assert.deepEqual(call.messages, [{ role: "user", content: "hi" }]);
    assert.equal(call.options?.maxTokens, 1);
  }
});

test("warmProviders resolves to an empty map when no Ollama provider is registered", async () => {
  const calls: FakeOptions["calls"] = [];
  const results = await warmProviders([fakeProvider("gemini", { calls }), fakeProvider("mock", { calls })]);
  assert.deepEqual(results, {});
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// warmupEnabled (OLLAMA_WARM opt-out)
// ---------------------------------------------------------------------------

test("warmupEnabled: only the exact string \"0\" disables the warmup", () => {
  assert.equal(warmupEnabled({ OLLAMA_WARM: "0" }), false);
  assert.equal(warmupEnabled({}), true);
  assert.equal(warmupEnabled({ OLLAMA_WARM: "1" }), true);
  assert.equal(warmupEnabled({ OLLAMA_WARM: undefined }), true);
});
