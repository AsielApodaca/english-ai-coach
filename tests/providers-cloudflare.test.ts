import { test } from "node:test";
import assert from "node:assert/strict";

import { createCloudflareProvider, CLOUDFLARE_DEFAULT_MODEL } from "../src/lib/providers/cloudflare.ts";
import { ProviderError, type ChatMessage } from "../src/lib/providers/types.ts";

// ---------------------------------------------------------------------------
// Feature 117 — specification tests for the Cloudflare Workers AI provider.
// Network I/O is mocked at the global `fetch` boundary (test-scoped, restored
// per test); the account id is always passed explicitly so the results never
// depend on the developer's ~/.config/opencode files.
// ---------------------------------------------------------------------------

const MSGS: ChatMessage[] = [
  { role: "system", content: "coach" },
  { role: "user", content: "hi" },
];

const TOKEN = "cf-test-token";
const ACCOUNT = "0123456789abcdef0123456789abcdef";

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

test("available(): false without a token; true with token + explicit account id", async () => {
  assert.equal(await createCloudflareProvider(undefined, ACCOUNT).available(), false);
  assert.equal(await createCloudflareProvider(TOKEN, ACCOUNT).available(), true);
});

test("complete(): happy path returns result.choices content and shapes the request", async (t) => {
  let captured: { url: string; init?: RequestInit } | undefined;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    captured = { url: String(input), init };
    return jsonResponse({ success: true, result: { choices: [{ message: { content: "Hello from CF" } }] } });
  });

  const reply = await createCloudflareProvider(TOKEN, ACCOUNT).complete(MSGS, { temperature: 0.1, maxTokens: 50 });
  assert.equal(reply, "Hello from CF");
  assert.ok(captured);
  assert.ok(captured.url.includes(`/accounts/${ACCOUNT}/ai/v1/chat/completions`));
  const headers = captured.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  const body = JSON.parse(String(captured.init?.body)) as Record<string, unknown>;
  assert.equal(body.model, CLOUDFLARE_DEFAULT_MODEL);
  assert.deepEqual(body.messages, MSGS);
  assert.deepEqual({ temperature: body.temperature, max_tokens: body.max_tokens }, { temperature: 0.1, max_tokens: 50 });
});

test("complete(): accepts the OpenAI-shaped top-level choices fallback", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    jsonResponse({ success: true, choices: [{ message: { content: "alt shape" } }] }),
  );
  const reply = await createCloudflareProvider(TOKEN, ACCOUNT).complete(MSGS);
  assert.equal(reply, "alt shape");
});

test("complete(): missing credentials fail as a non-retryable ProviderError", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () => jsonResponse({}));
  await rejectsWithProviderError(createCloudflareProvider(undefined, ACCOUNT).complete(MSGS), (err) => {
    assert.equal(err.canRetry, false);
    assert.equal(err.provider, "cloudflare");
    assert.match(err.message, /credentials missing/);
  });
  assert.equal(mock.mock.callCount(), 0, "no network call without credentials");
});

test("complete(): 429/5xx are retryable, 4xx is not (errors[] message wins)", async (t) => {
  const mock = t.mock.method(globalThis, "fetch", async () =>
    jsonResponse({ success: false, errors: [{ code: 1000, message: "bad model name" }] }, 400),
  );
  await rejectsWithProviderError(createCloudflareProvider(TOKEN, ACCOUNT).complete(MSGS), (err) => {
    assert.equal(err.canRetry, false);
    assert.match(err.message, /cloudflare 400: bad model name/);
  });

  mock.mock.mockImplementation(async () => jsonResponse({}, 429));
  await rejectsWithProviderError(createCloudflareProvider(TOKEN, ACCOUNT).complete(MSGS), (err) => {
    assert.equal(err.canRetry, true);
    assert.match(err.message, /cloudflare 429/);
  });

  mock.mock.mockImplementation(async () => jsonResponse({}, 500));
  await rejectsWithProviderError(createCloudflareProvider(TOKEN, ACCOUNT).complete(MSGS), (err) => {
    assert.equal(err.canRetry, true);
  });
});

test("complete(): success:false on HTTP 200 is a non-retryable failure", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse({ success: false }, 200));
  await rejectsWithProviderError(createCloudflareProvider(TOKEN, ACCOUNT).complete(MSGS), (err) => {
    // Status 200 → canRetry stays false even though the payload says failure.
    assert.equal(err.canRetry, false);
    assert.match(err.message, /cloudflare 200: unsuccessful/);
  });
});

test("complete(): 200 without content is a retryable ProviderError", async (t) => {
  t.mock.method(globalThis, "fetch", async () => jsonResponse({ success: true, result: { choices: [] } }));
  await rejectsWithProviderError(createCloudflareProvider(TOKEN, ACCOUNT).complete(MSGS), (err) => {
    assert.equal(err.canRetry, true);
    assert.match(err.message, /empty content/);
  });
});

test("complete(): a custom model overrides the default in the body", async (t) => {
  let body: Record<string, unknown> | undefined;
  t.mock.method(globalThis, "fetch", async (_input: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return jsonResponse({ success: true, result: { choices: [{ message: { content: "ok" } }] } });
  });
  await createCloudflareProvider(TOKEN, ACCOUNT, "@cf/custom-model").complete(MSGS);
  assert.equal(body?.model, "@cf/custom-model");
});
