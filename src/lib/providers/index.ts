import type { ChatMessage, CompleteOptions, Provider, ProviderId } from "./types.ts";
import { ProviderError } from "./types.ts";
import { createZenProvider } from "./zen.ts";
import { createGeminiProvider } from "./gemini.ts";
import { createCloudflareProvider } from "./cloudflare.ts";
import { createOllamaProvider } from "./ollama.ts";

export * from "./types.ts";

export interface Env extends Record<string, string | undefined> {
  LLM_PROVIDER?: string;
  ZEN_API_KEY?: string;
  GEMINI_API_KEY?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CLOUDFLARE_MODEL?: string;
  OLLAMA_MODEL?: string;
}

/** Build the provider registry from environment/config. */
export function buildProviders(env: Env): Provider[] {
  return [
    createZenProvider(env.ZEN_API_KEY),
    createGeminiProvider(env.GEMINI_API_KEY),
    createCloudflareProvider(env.CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_ACCOUNT_ID, env.CLOUDFLARE_MODEL),
    createOllamaProvider(undefined, env.OLLAMA_MODEL),
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
 * Try completing with a list of candidate providers (primary first). Falls back
 * on checkable failures (unavailable / canRetry). Skips providers that are not
 * configured. Throws a combined ProviderError if every candidate fails.
 */
export async function completeWithFallback(
  candidates: Pick<Provider, "id" | "available" | "complete">[],
  messages: ChatMessage[],
  options: CompleteOptions = {},
): Promise<{ provider: string; text: string }> {
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      if (!(await candidate.available())) {
        errors.push(`${candidate.id}: not configured`);
        continue;
      }
      const text = await candidate.complete(messages, options);
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
  throw new Error(`No JSON found in model reply: ${text.slice(0, 200)}`);
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