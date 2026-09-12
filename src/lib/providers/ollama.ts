import type { ChatMessage, Provider, CompleteOptions } from "./types.ts";
import { ProviderError } from "./types.ts";

const OLLAMA_BASE = "http://localhost:11434/v1";
export const OLLAMA_DEFAULT_MODEL = "llama3.1";

interface OllamaResponse {
  choices?: { message?: { content?: string } }[];
}

export async function pingOllama(baseUrl = OLLAMA_BASE): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
}

export function createOllamaProvider(baseUrl = OLLAMA_BASE, defaultModel = OLLAMA_DEFAULT_MODEL): Provider {
  return {
    id: "ollama",
    name: "Ollama (local)",
    async available() {
      return pingOllama(baseUrl);
    },
    async complete(messages: ChatMessage[], options: CompleteOptions = {}) {
      const up = await pingOllama(baseUrl);
      if (!up) throw new ProviderError("Ollama is not running (start `ollama serve` first)", false, "ollama");
      const model = options.model ?? defaultModel;
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.4,
          options: { num_predict: options.maxTokens ?? 2048 },
        }),
        signal: options.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new ProviderError(`ollama ${res.status}: ${text.slice(0, 200)}`, res.status === 429 || res.status >= 500, "ollama");
      }
      const data = (await res.json().catch(() => ({}))) as OllamaResponse;
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new ProviderError("ollama returned empty content", true, "ollama");
      return content;
    },
  };
}