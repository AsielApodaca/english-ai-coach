import type { ChatMessage, CompleteOptions, Provider, ProviderId } from "./types.ts";
import { ProviderError, REPLY_SNIP_LEN, isProviderId } from "./types.ts";
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
    const parsed = scanBlock(cleaned, idx);
    if (parsed === undefined) continue;
    if (parsed.duplicateKey !== undefined) {
      // A reply whose objects repeat a key is structurally invalid even though
      // JSON.parse accepts it (last value wins). The local model produces this
      // when it drops the `}{` separator between array items: every item folds
      // into ONE object and only the last item's values survive — the classic
      // "single-fragment answer" bug. Fail loudly so the caller can retry.
      throw new Error(
        `Duplicate key "${parsed.duplicateKey}" in model reply JSON: ${cleaned.slice(parsed.start, parsed.end).slice(0, REPLY_SNIP_LEN)}`,
      );
    }
    try {
      return JSON.parse(cleaned.slice(parsed.start, parsed.end)) as T;
    } catch (err) {
      throw new Error(`Invalid JSON in model reply: ${(err as Error).message}`);
    }
  }
  throw new Error(`No JSON found in model reply: ${text.slice(0, REPLY_SNIP_LEN)}`);
}

/** One brace frame of the JSON scanner: object frames collect their keys. */
interface ScanFrame {
  kind: "object" | "array";
  keys: Set<string>;
  /** True while the next string in an object frame would be a key, not a value. */
  expectKey: boolean;
}

interface ScannedBlock {
  start: number;
  end: number;
  /** First duplicated key found in any object, or `undefined` when the block is clean. */
  duplicateKey?: string;
}

/**
 * Scan from `idx` for the balanced JSON block that starts there, tracking
 * object keys as it goes so duplicate keys can be reported.
 * Returns `undefined` when the block never closes (the caller then tries the
 * next start token).
 */
function scanBlock(cleaned: string, idx: number): ScannedBlock | undefined {
  const stack: ScanFrame[] = [];
  let inString = false;
  let escaped = false;
  let stringStart = 0;
  let duplicateKey: string | undefined;

  for (let i = idx; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') {
        inString = false;
        const frame = stack[stack.length - 1];
        if (frame?.kind === "object" && frame.expectKey && duplicateKey === undefined) {
          const key = cleaned.slice(stringStart, i);
          if (frame.keys.has(key)) duplicateKey = key;
          else frame.keys.add(key);
        }
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      stringStart = i + 1;
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push({ kind: ch === "{" ? "object" : "array", keys: new Set(), expectKey: ch === "{" });
      continue;
    }
    if (ch === "}" || ch === "]") {
      stack.pop();
      if (stack.length === 0) return { start: idx, end: i + 1, duplicateKey };
      continue;
    }
    if (ch === ":") {
      const frame = stack[stack.length - 1];
      if (frame) frame.expectKey = false;
      continue;
    }
    if (ch === ",") {
      const frame = stack[stack.length - 1];
      if (frame?.kind === "object") frame.expectKey = true;
    }
  }
  return undefined;
}

/** Default number of times `chatJSON` asks the provider chain for a usable reply. */
export const CHAT_JSON_ATTEMPTS = 3;

/**
 * Sends a request with a JSON system prompt and returns structured data.
 *
 * @param params.system - JSON-only system prompt
 * @param params.user - user message
 * @param params.options - sampling options
 * @param params.schema - optional JSON Schema forwarded to providers that
 *   support structured outputs (Ollama: constrained sampling)
 * @param params.validate - optional shape check run on the parsed value;
 *   a throw is treated like a parse failure and triggers a retry
 *
 * Malformed or shape-rejected replies are retried (up to `CHAT_JSON_ATTEMPTS`
 * calls to the chain) because local models occasionally emit structurally
 * invalid JSON. Exhausting the attempts throws a `ProviderError` quoting the
 * last reply; a chain that fails outright propagates immediately instead of
 * burning retries.
 */
export async function chatJSON<T>(
  candidates: Pick<Provider, "id" | "available" | "complete">[],
  params: {
    system: string;
    user: string;
    options?: CompleteOptions;
    schema?: CompleteOptions["jsonSchema"];
    validate?: (data: T) => void;
  },
): Promise<{ data: T; provider: string }> {
  const messages: ChatMessage[] = [
    { role: "system", content: params.system },
    { role: "user", content: params.user },
  ];
  const options: CompleteOptions = { ...params.options };
  if (params.schema) options.jsonSchema = params.schema;

  let last: Error | undefined;
  let lastProvider = "unknown";
  for (let attempt = 1; attempt <= CHAT_JSON_ATTEMPTS; attempt++) {
    const result = await completeWithFallback(candidates, messages, options);
    lastProvider = result.provider;
    try {
      const data = extractJSON<T>(result.text);
      params.validate?.(data);
      return { data, provider: result.provider };
    } catch (err) {
      last = err instanceof Error ? err : new Error(String(err));
      if (attempt < CHAT_JSON_ATTEMPTS) continue;
    }
  }
  throw new ProviderError(
    `No usable JSON reply after ${CHAT_JSON_ATTEMPTS} attempts: ${last?.message ?? "unknown"}`,
    false,
    isProviderId(lastProvider) ? lastProvider : "unknown",
  );
}
