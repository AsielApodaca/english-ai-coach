import type { ChatMessage, CompleteOptions, Provider, ProviderId } from "./types.ts";
import { ProviderError, REPLY_SNIP_LEN } from "./types.ts";
import { createGeminiProvider } from "./gemini.ts";
import { createCloudflareProvider } from "./cloudflare.ts";
import { createOllamaProvider } from "./ollama.ts";
import { createMockProvider } from "./mock.ts";

export * from "./types.ts";

export interface Env extends Record<string, string | undefined> {
  LLM_PROVIDER?: string;
  GEMINI_API_KEY?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_MODEL?: string;
  OLLAMA_MODEL?: string;
  /** KV-cache window (tokens) for the session model; default 32768. */
  OLLAMA_CTX?: string;
  /** Fast local model that serves the lookup popup (e.g. phi4-mini). */
  OLLAMA_FAST_MODEL?: string;
  /** KV-cache window (tokens) for the fast lookup model; default 8192. */
  OLLAMA_FAST_CTX?: string;
  /** Local-model warmup at boot/app-load: enabled unless set to the string "0". */
  OLLAMA_WARM?: string;
  /** TEMPORARY testing aid: MOCK_LLM=1 serves canned LLM replies (provider "mock"). */
  MOCK_LLM?: string;
}

/** Parse an env-declared `num_ctx`, falling back on missing/invalid values. */
function parseCtx(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Build the provider registry from environment/config.
 *
 * Order (mock first when `MOCK_LLM` is set) is what the practice flow relies
 * on and must not change. When `OLLAMA_FAST_MODEL` is configured, a second
 * Ollama provider (`"ollama-fast"`, small `num_ctx`) is appended; the lookup
 * popup puts it ahead of the chain via `lookupCandidates()` in `server.ts`.
 */
export function buildProviders(env: Env): Provider[] {
  const mock = env.MOCK_LLM ? [createMockProvider()] : [];
  const fast = env.OLLAMA_FAST_MODEL
    ? [createOllamaProvider(undefined, env.OLLAMA_FAST_MODEL, { id: "ollama-fast", numCtx: parseCtx(env.OLLAMA_FAST_CTX, 8192) })]
    : [];
  return [
    ...mock,
    createGeminiProvider(env.GEMINI_API_KEY),
    createCloudflareProvider(env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_MODEL),
    createOllamaProvider(undefined, env.OLLAMA_MODEL, { id: "ollama", numCtx: parseCtx(env.OLLAMA_CTX, 32768) }),
    ...fast,
  ];
}

export function providerById(providers: Provider[], id: ProviderId | undefined): Provider | undefined {
  if (!id) return undefined;
  return providers.find((p) => p.id === id);
}

export async function providerStatus(providers: Provider[]): Promise<Map<string, boolean>> {
  const status = new Map<string, boolean>();
  await Promise.all(
    providers.map(async (p) => {
      try {
        status.set(p.id, await p.available());
      } catch {
        status.set(p.id, false);
      }
    }),
  );
  return status;
}

/**
 * Whether the local-model warmup runs at server boot and app load. On by
 * default; only the exact string `OLLAMA_WARM="0"` opts out.
 */
export function warmupEnabled(env: Pick<Env, "OLLAMA_WARM">): boolean {
  return env.OLLAMA_WARM !== "0";
}

/**
 * Warm every local Ollama-backed provider with a 1-token completion.
 *
 * Rationale: the first request to a local Ollama model pays the model load —
 * weights are read from disk and the KV cache is allocated (phi4-mini ~2-3 s,
 * qwen3.5:9b ~10-17 s), which makes the first session or lookup popup feel
 * laggy. Asking each Ollama provider for a single token forces Ollama to load
 * the weights and KV cache with EXACTLY the parameters the real call will use
 * (the provider's baked-in `num_ctx`, the native `/api/chat` endpoint and
 * `think:false`), so the warm allocation matches the real one. The provider's
 * regular idle `keep_alive` of 5 min then keeps the model resident — we
 * deliberately do NOT pass `keep_alive` so that default applies untouched.
 *
 * Only `ollama` / `ollama-fast` providers are targeted (never gemini,
 * cloudflare or mock). They run in parallel; a throw marks that provider
 * `false` and never rejects the batch.
 *
 * @param providers - full provider registry
 * @returns per-provider warm outcome keyed by provider id
 */
export async function warmProviders(providers: Provider[]): Promise<Record<string, boolean>> {
  const targets = providers.filter((p) => p.id === "ollama" || p.id === "ollama-fast");
  const results = await Promise.all(
    targets.map(async (p): Promise<readonly [string, boolean]> => {
      try {
        await p.complete([{ role: "user", content: "hi" }], { maxTokens: 1 });
        return [p.id, true];
      } catch {
        return [p.id, false];
      }
    }),
  );
  return Object.fromEntries(results);
}

/**
 * Try completing with a list of candidate providers (primary first). Falls back
 * on checkable failures (unavailable / canRetry). Skips providers that are not
 * configured. Throws a combined ProviderError if every candidate fails.
 *
 * Every provider call is bounded by a generous safety timeout (default 5min,
 * override with LLM_TIMEOUT_MS) meant ONLY to catch a true infinite hang and
 * let the chain try the next provider. It is NOT a fast lane: a slow-but-alive
 * provider (common on free tiers) is allowed to finish, because cutting it off
 * and failing over to unconfigured providers would turn a slow start into a
 * hard 502.
 */
export async function completeWithFallback(
  candidates: Pick<Provider, "id" | "available" | "complete">[],
  messages: ChatMessage[],
  options: CompleteOptions = {},
): Promise<{ provider: string; text: string }> {
  const errors: string[] = [];
  const timeoutMs = Number(process.env.LLM_TIMEOUT_MS ?? 300_000) || 300_000;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  for (const candidate of candidates) {
    try {
      if (!(await candidate.available())) {
        errors.push(`${candidate.id}: not configured`);
        continue;
      }
      const text = await candidate.complete(messages, { ...options, signal });
      return { provider: candidate.id, text };
    } catch (err) {
      const e = err instanceof ProviderError ? err : new ProviderError(String(err));
      errors.push(`${candidate.id}: ${e.message}`);
      if (!e.canRetry) {
        // A definitive config failure on the primary shouldn't end fallback for
        // that provider only; try the next candidate regardless.
        errors.push(`${candidate.id}: not retrying`);
      }
    }
  }
  throw new ProviderError(`All LLM providers failed:\n${errors.join("\n")}`, false, "unknown");
}

/** Extract a JSON value from a model reply, tolerating fences, prose and noise. */
export function extractJSON<T>(text: string): T {
  const cleaned = text
    .replace(/```(?:json)?/gi, "")
    .trim();
  const starts = ["{", "["];
  for (const start of starts) {
    const idx = cleaned.indexOf(start);
    if (idx === -1) continue;
    const endChar = start === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = idx; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === start) depth++;
      else if (ch === endChar) {
        depth--;
        if (depth === 0) {
          const slice = cleaned.slice(idx, i + 1);
          return JSON.parse(slice) as T;
        }
      }
    }
  }
  throw new Error(`No JSON found in model reply: ${text.slice(0, REPLY_SNIP_LEN)}`);
}

/** Sends a request with a JSON system prompt and returns structured data. */
export async function chatJSON<T>(
  candidates: Pick<Provider, "id" | "available" | "complete">[],
  params: { system: string; user: string; options?: CompleteOptions },
): Promise<{ data: T; provider: string }> {
  const messages: ChatMessage[] = [
    { role: "system", content: params.system },
    { role: "user", content: params.user },
  ];
  const result = await completeWithFallback(candidates, messages, params.options);
  return { data: extractJSON<T>(result.text), provider: result.provider };
}