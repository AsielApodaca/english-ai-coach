import { test } from "node:test";
import assert from "node:assert/strict";

import { createOllamaProvider, pingOllama, OLLAMA_DEFAULT_MODEL } from "../src/lib/providers/ollama.ts";
import { LLM_DEFAULT_MAX_TOKENS, LLM_DEFAULT_TEMPERATURE, ProviderError, type ChatMessage } from "../src/lib/providers/types.ts";

// ---------------------------------------------------------------------------
// Feature 117 — specification tests for the local Ollama provider. The chat
// call runs a health ping first (`GET /models`) and only then hits the NATIVE
// `POST /api/chat` endpoint; both hops are mocked at the global `fetch`
// boundary, and one case asserts that a failed ping never reaches /api/chat.
// ---------------------------------------------------------------------------

const MSGS: ChatMessage[] = [{ role: "user", content: "hi" }];

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function rejectsWithProviderError(promise: Promise<unknown>, check: (err: ProviderError) => void): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof ProviderError, `expected ProviderError, got ${String(err)}`);
    check(err);
    return true;
  });
}

test("pingOllama: true on HTTP 200, false when the server refuses the connection", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 200 }));
  assert.equal(await pingOllama(), true);

  mock.mock.mockImplementation(async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal(await pingOllama(), false);
});

test("available(): mirrors the health ping", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 200 }));
  assert.equal(await createOllamaProvider().available(), true);

  mock.mock.mockImplementation(async () => {
    throw new Error("ECONNREFUSED");
  });
  assert.equal(await createOllamaProvider().available(), false);
});

test("complete(): ping then native /api/chat, with think:false and the baked num_ctx", async (t) => {
  const calls: { url: string; body?: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/models")) return new Response("{}", { status: 200 });
    calls.push({ url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return jsonResponse({ message: { content: "local reply" } });
  });

  const reply = await createOllamaProvider().complete(MSGS, { maxTokens: 64 });
  assert.equal(reply, "local reply");
  assert.equal(calls.length, 1, "exactly one chat call after the ping");
  // Origin derived from the OpenAI-compat base: /v1 stripped for the native API.
  assert.equal(calls[0].url, "http://localhost:11434/api/chat");
  assert.deepEqual(calls[0].body, {
    model: OLLAMA_DEFAULT_MODEL,
    messages: MSGS,
    stream: false,
    think: false,
    temperature: LLM_DEFAULT_TEMPERATURE,
    options: { num_predict: 64, num_ctx: 32768 },
  });
});

test("complete(): a dead server fails WITHOUT reaching /api/chat", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("ECONNREFUSED");
  });
  await rejectsWithProviderError(createOllamaProvider().complete(MSGS), (err) => {
    assert.equal(err.canRetry, false);
    assert.equal(err.provider, "ollama");
    assert.match(err.message, /not running/);
  });
  assert.equal(mock.mock.callCount(), 1, "only the ping ran");
});

test("complete(): custom base URL, provider id and numCtx are honoured", async (t) => {
  let chat: { url: string; body?: Record<string, unknown> } | undefined;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/models")) return new Response("{}", { status: 200 });
    chat = { url, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    return jsonResponse({ message: { content: "fast" } });
  });

  const fast = createOllamaProvider("http://127.0.0.1:2222/v1", "phi4-mini", { id: "ollama-fast", numCtx: 8192 });
  assert.equal(fast.id, "ollama-fast");
  await fast.complete(MSGS);
  assert.ok(chat);
  assert.equal(chat.url, "http://127.0.0.1:2222/api/chat");
  assert.equal(chat.body?.model, "phi4-mini");
  assert.deepEqual(chat.body?.options, { num_predict: LLM_DEFAULT_MAX_TOKENS, num_ctx: 8192 });
});

test("complete(): chat status mapping — 5xx retryable, 4xx not", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).endsWith("/models")) return new Response("{}", { status: 200 });
    return new Response("server exploded", { status: 500 });
  });
  await rejectsWithProviderError(createOllamaProvider().complete(MSGS), (err) => {
    assert.equal(err.canRetry, true);
    assert.match(err.message, /ollama 500: server exploded/);
  });

  mock.mock.mockImplementation(async (input: string | URL | Request) => {
    if (String(input).endsWith("/models")) return new Response("{}", { status: 200 });
    return new Response("not found", { status: 404 });
  });
  await rejectsWithProviderError(createOllamaProvider().complete(MSGS), (err) => {
    assert.equal(err.canRetry, false);
    assert.match(err.message, /ollama 404: not found/);
  });
});

test("complete(): 200 without content is a retryable ProviderError", async (t) => {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).endsWith("/models")) return new Response("{}", { status: 200 });
    return jsonResponse({});
  });
  await rejectsWithProviderError(createOllamaProvider().complete(MSGS), (err) => {
    assert.equal(err.canRetry, true);
    assert.match(err.message, /empty content/);
  });
});
