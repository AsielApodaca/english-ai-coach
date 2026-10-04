import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildProviders,
  extractJSON,
  providerById,
  providerStatus,
  warmupEnabled,
  completeWithFallback,
} from "../src/lib/providers/index.ts";
import { ProviderError, type ChatMessage, type Provider, type ProviderId } from "../src/lib/providers/types.ts";

// ---------------------------------------------------------------------------
// Feature 117 — registry-level specification: how the env becomes the provider
// chain (order + opt-ins), how availability is probed, how extractJSON tames
// real model replies, and how completeWithFallback converts ANY failure —
// including an aborted fetch — into a ProviderError while walking the chain.
// These complement tests/coach.test.ts, which pins the fallback happy paths.
// ---------------------------------------------------------------------------

const MSGS: ChatMessage[] = [{ role: "user", content: "hi" }];

function fakeProvider(id: ProviderId, opts: { available?: () => Promise<boolean>; reply?: string } = {}): Provider {
  return {
    id,
    name: id,
    available: opts.available ?? (async () => true),
    complete: async () => opts.reply ?? `reply-from-${id}`,
  };
}

// --- buildProviders: env → chain order -------------------------------------

test("buildProviders: default env → gemini, cloudflare, ollama (no mock, no fast)", () => {
  assert.deepEqual(buildProviders({}).map((p) => p.id), ["gemini", "cloudflare", "ollama"]);
});

test("buildProviders: MOCK_LLM leads the chain, OLLAMA_FAST_MODEL appends ollama-fast", () => {
  assert.deepEqual(buildProviders({ MOCK_LLM: "1" }).map((p) => p.id), ["mock", "gemini", "cloudflare", "ollama"]);
  assert.deepEqual(buildProviders({ OLLAMA_FAST_MODEL: "phi4-mini" }).map((p) => p.id), [
    "gemini",
    "cloudflare",
    "ollama",
    "ollama-fast",
  ]);
  // Empty string is "set but falsy" — treated as configured (env vars are strings).
  assert.deepEqual(buildProviders({ MOCK_LLM: "" }).map((p) => p.id)[0], "gemini");
});

test("buildProviders: ids are unique so providerById can address each slot", () => {
  const ids = buildProviders({ MOCK_LLM: "1", OLLAMA_FAST_MODEL: "phi4-mini" }).map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});

// --- warmupEnabled / providerById / providerStatus ---------------------------

test("warmupEnabled: on by default; only the exact string OLLAMA_WARM=0 opts out", () => {
  assert.equal(warmupEnabled({}), true);
  assert.equal(warmupEnabled({ OLLAMA_WARM: undefined }), true);
  assert.equal(warmupEnabled({ OLLAMA_WARM: "1" }), true);
  assert.equal(warmupEnabled({ OLLAMA_WARM: "false" }), true);
  assert.equal(warmupEnabled({ OLLAMA_WARM: "0" }), false);
});

test("providerById: finds configured providers, rejects unknown ids", () => {
  const providers = buildProviders({});
  assert.equal(providerById(providers, "gemini")?.id, "gemini");
  assert.equal(providerById(providers, "mock"), undefined);
  assert.equal(providerById(providers, undefined), undefined);
});

test("providerStatus: reports availability per id; a throwing probe counts as false", async () => {
  const status = await providerStatus([
    fakeProvider("gemini", { available: async () => true }),
    fakeProvider("cloudflare", { available: async () => false }),
    fakeProvider("ollama", { available: async () => { throw new Error("probe blew up"); } }),
  ]);
  assert.deepEqual(Object.fromEntries(status), { gemini: true, cloudflare: false, ollama: false });
});

// --- extractJSON: the reply-shaped defense ----------------------------------

test("extractJSON: tolerates code fences, prose and leading noise", () => {
  assert.deepEqual(extractJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJSON('Sure! Here you go:\n{"a": {"b": "}"}}\nHope that helps.'), { a: { b: "}" } });
  assert.deepEqual(extractJSON('noise before [1, 2, 3] and after'), [1, 2, 3]);
  assert.deepEqual(extractJSON('``` {"fence": true} ```'), { fence: true });
  // A fenced multi-line reply with trailing commentary (typical model wrap).
  assert.deepEqual(extractJSON('Answer:\n```json\n{"ok": true}\n```\nAnything else?'), { ok: true });
});

test("extractJSON: a reply without JSON throws instead of guessing", () => {
  assert.throws(() => extractJSON("I cannot answer that."), /No JSON found/);
  assert.throws(() => extractJSON("{broken forever"), /No JSON found/);
});

// --- completeWithFallback: failure conversion (abort included) ---------------

test("completeWithFallback: skips providers that are not configured", async () => {
  const result = await completeWithFallback(
    [fakeProvider("gemini", { available: async () => false }), fakeProvider("ollama", { reply: "second" })],
    MSGS,
  );
  assert.equal(result.provider, "ollama");
});

test("completeWithFallback: an aborted fetch (AbortError) falls through to the next provider", async () => {
  const aborted: Provider = {
    id: "gemini",
    name: "aborted",
    available: async () => true,
    complete: async () => {
      // Exactly what the real providers do: `fetch` rejects when its signal fires.
      throw new DOMException("This operation was aborted", "AbortError");
    },
  };
  const result = await completeWithFallback([aborted, fakeProvider("ollama", { reply: "after abort" })], MSGS);
  assert.equal(result.provider, "ollama");
  assert.equal(result.text, "after abort");
});

test("completeWithFallback: when every provider aborts, the combined error is a non-retryable ProviderError", async () => {
  const alwaysAbort: Provider = {
    id: "ollama",
    name: "aborted",
    available: async () => true,
    complete: async () => {
      throw new DOMException("This operation was aborted", "AbortError");
    },
  };
  await assert.rejects(completeWithFallback([alwaysAbort], MSGS), (err: unknown) => {
    assert.ok(err instanceof ProviderError);
    assert.equal(err.canRetry, false);
    assert.equal(err.provider, "unknown");
    assert.match(err.message, /All LLM providers failed/);
    // The raw AbortError text survives inside the combined message.
    assert.match(err.message, /AbortError|aborted/);
    return true;
  });
});
