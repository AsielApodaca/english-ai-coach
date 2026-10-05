import { test } from "node:test";
import assert from "node:assert/strict";

import { createGeminiProvider, GEMINI_DEFAULT_MODEL } from "../src/lib/providers/gemini.ts";
import { ProviderError, type ChatMessage } from "../src/lib/providers/types.ts";

// ---------------------------------------------------------------------------
// Feature 117 — specification tests for the Gemini provider. All network I/O
// is mocked at the global `fetch` boundary (test-scoped mock, auto-restored),
// so `complete()` is pinned down to: request shape, status → canRetry mapping
// and empty-content handling. No new test dependencies.
// ---------------------------------------------------------------------------

const MSGS: ChatMessage[] = [
  { role: "system", content: "You are a coach." },
  { role: "user", content: "Say hi" },
  { role: "assistant", content: "Hi!" },
];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Assert `promise` rejects with a ProviderError and inspect its fields. */
async function rejectsWithProviderError(
  promise: Promise<unknown>,
  check: (err: ProviderError) => void,
): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ProviderError, `expected ProviderError, got ${String(err)}`);
    check(err);
    return true;
  });
}

test("available(): true only when an API key was configured", async () => {
  assert.equal(await createGeminiProvider(undefined).available(), false);
  assert.equal(await createGeminiProvider("").available(), false);
  assert.equal(await createGeminiProvider("AIza-test-key").available(), true);
});

test("complete(): happy path returns the candidate text and shapes the request", async (t) => {
  let captured: { url: string; init?: RequestInit } | undefined;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(input), init };
    return jsonResponse({ candidates: [{ content: { parts: [{ text: "Hello there" }] } }] });
  });

  const provider = createGeminiProvider("k-123");
  const reply = await provider.complete(MSGS, { temperature: 0.2, maxTokens: 100 });
  assert.equal(reply, "Hello there");
  assert.ok(captured);
  // URL: default model + key in the query string.
  assert.ok(captured.url.includes(`/models/${GEMINI_DEFAULT_MODEL}:generateContent?key=k-123`));
  const body = JSON.parse(String(captured.init?.body)) as Record<string, unknown>;
  // system prompt → systemInstruction; the rest keeps order, assistant → "model".
  assert.deepEqual(body.systemInstruction, { parts: [{ text: "You are a coach." }] });
  assert.deepEqual(body.contents, [
    { role: "user", parts: [{ text: "Say hi" }] },
    { role: "model", parts: [{ text: "Hi!" }] },
  ]);
  assert.deepEqual(body.generationConfig, { temperature: 0.2, maxOutputTokens: 100 });
});

test("complete(): 429/5xx are retryable ProviderErrors, 4xx are not", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => jsonResponse({ error: { message: "quota" } }, 429));
  await rejectsWithProviderError(createGeminiProvider("k").complete(MSGS), (err) => {
    assert.equal(err.canRetry, true);
    assert.equal(err.provider, "gemini");
    assert.match(err.message, /gemini 429: quota/);
  });

  mock.mock.mockImplementation(async () => jsonResponse({ error: { message: "boom" } }, 503));
  await rejectsWithProviderError(createGeminiProvider("k").complete(MSGS), (err) => {
    assert.equal(err.canRetry, true);
  });

  mock.mock.mockImplementation(async () => jsonResponse({ error: { message: "bad request" } }, 400));
  await rejectsWithProviderError(createGeminiProvider("k").complete(MSGS), (err) => {
    assert.equal(err.canRetry, false);
    assert.match(err.message, /gemini 400: bad request/);
  });
});

test("complete(): a non-JSON error body still yields a status-bearing message", async (t) => {
  // 503 (retryable per gemini's set: 429/500/503) with an HTML body: the JSON
  // parse fails silently and the message falls back to the status line.
  t.mock.method(globalThis, "fetch", async () => new Response("<html>Service Unavailable</html>", { status: 503 }));
  await rejectsWithProviderError(createGeminiProvider("k").complete(MSGS), (err) => {
    assert.equal(err.canRetry, true);
    assert.match(err.message, /gemini 503: HTTP 503/);
  });
});

test("complete(): 200 without content is a retryable ProviderError", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse({ candidates: [] }));
  await rejectsWithProviderError(createGeminiProvider("k").complete(MSGS), (err) => {
    assert.equal(err.canRetry, true);
    assert.match(err.message, /empty content/);
  });
});

test("complete(): a missing key fails without touching the network", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => jsonResponse({}));
  await rejectsWithProviderError(createGeminiProvider(undefined).complete(MSGS), (err) => {
    assert.equal(err.canRetry, false);
    assert.match(err.message, /GEMINI_API_KEY/);
  });
  assert.equal(mock.mock.callCount(), 0);
});

test("complete(): a custom model and the abort signal reach the request", async (t) => {
  let captured: { url: string; init?: RequestInit } | undefined;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(input), init };
    return jsonResponse({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
  });
  const controller = new AbortController();
  await createGeminiProvider("k", "gemini-custom").complete(MSGS, { signal: controller.signal });
  assert.ok(captured?.url.includes("/models/gemini-custom:generateContent"));
  assert.equal(captured?.init?.signal, controller.signal);
});
