import type { ChatMessage, Provider, CompleteOptions, ProviderId } from "./types.ts";
import { LLM_DEFAULT_MAX_TOKENS, LLM_DEFAULT_TEMPERATURE, ProviderError, REPLY_SNIP_LEN } from "./types.ts";

const OLLAMA_BASE = "http://localhost:11434/v1";
export const OLLAMA_DEFAULT_MODEL = "llama3.1";

/** Default KV-cache context (tokens) per call: caps VRAM/RAM per concurrent request. */
const DEFAULT_NUM_CTX = 32768;

/** Native `/api/chat` response shape: `{ message: { content } }`. */
interface OllamaChatResponse {
  message?: { content?: string };
}

/**
 * Options for `createOllamaProvider`.
 *
 * - `id` lets several providers of the same runtime coexist in the registry
 *   (e.g. `"ollama"` for the session model and `"ollama-fast"` for the small
 *   model that serves the lookup popup).
 * - `numCtx` caps `options.num_ctx`, the KV-cache window Ollama allocates per
 *   request; smaller values allow more concurrent calls within the same RAM.
 */
export interface OllamaProviderOptions {
  id?: ProviderId;
  numCtx?: number;
}

/**
 * Health probe against the OpenAI-compat surface (`GET /models`), used both by
 * `available()` and as a pre-flight before every chat call.
 *
 * @param baseUrl - OpenAI-compat base URL (defaults to `http://localhost:11434/v1`)
 */
export async function pingOllama(baseUrl = OLLAMA_BASE): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Derive the server origin from the OpenAI-compat base URL (strip `/v1`). */
function originOf(baseUrl: string): string {
  return baseUrl.endsWith("/v1") ? baseUrl.slice(0, -"/v1".length) : baseUrl.replace(/\/+$/, "");
}

/**
 * Create a provider backed by a local Ollama server.
 *
 * Chat calls go to the NATIVE `POST /api/chat` endpoint rather than the
 * OpenAI-compat one, because only the native API understands `"think": false`.
 * That flag matters for thinking models (e.g. `qwen3.5:9b`): without it the
 * server streams reasoning before the answer, which both slows the reply down
 * and breaks strict-JSON parsing; non-thinking models (e.g. `phi4-mini`)
 * simply ignore the flag. `options.num_ctx` bounds the KV cache per call so a
 * burst of concurrent requests cannot exhaust RAM. When `options.jsonSchema`
 * is given it becomes `format`, which makes the server constrain sampling to
 * that schema — the reply is then guaranteed well-formed JSON (the local model
 * otherwise occasionally emits array items without their `}{` separator, which
 * JSON.parse accepts with duplicate keys and silently collapses).
 *
 * Health checks keep using the OpenAI-compat `/models` path (`pingOllama`).
 *
 * @param baseUrl - OpenAI-compat base URL (origin is derived from it for chat)
 * @param defaultModel - model used when `options.model` is not given
 * @param opts - provider `id` (default `"ollama"`) and `numCtx` (default 32768)
 */
export function createOllamaProvider(
  baseUrl = OLLAMA_BASE,
  defaultModel = OLLAMA_DEFAULT_MODEL,
  opts: OllamaProviderOptions = {},
): Provider {
  const id = opts.id ?? "ollama";
  const numCtx = opts.numCtx ?? DEFAULT_NUM_CTX;
  return {
    id,
    name: "Ollama (local)",
    async available() {
      return pingOllama(baseUrl);
    },
    async complete(messages: ChatMessage[], options: CompleteOptions = {}) {
      const up = await pingOllama(baseUrl);
      if (!up) throw new ProviderError("Ollama is not running (start `ollama serve` first)", false, id);
      const model = options.model ?? defaultModel;
      const res = await fetch(`${originOf(baseUrl)}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          think: false,
          temperature: options.temperature ?? LLM_DEFAULT_TEMPERATURE,
          // Structured outputs: Ollama constrains sampling to the schema, so
          // the reply is guaranteed to be well-formed JSON with one object per
          // array item (feature: strict first-question generation). Omitted
          // entirely when no schema is given, keeping the default body intact.
          ...(options.jsonSchema ? { format: options.jsonSchema } : {}),
          options: { num_predict: options.maxTokens ?? LLM_DEFAULT_MAX_TOKENS, num_ctx: numCtx },
        }),
        signal: options.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ProviderError(`ollama ${res.status}: ${text.slice(0, REPLY_SNIP_LEN)}`, res.status === 429 || res.status >= 500, id);
      }
      const data = (await res.json().catch(() => ({}))) as OllamaChatResponse;
      const content = data.message?.content;
      if (!content) throw new ProviderError("ollama returned empty content", true, id);
      return content;
    },
  };
}
