import type { ChatMessage, Provider, CompleteOptions } from "./types.ts";
import { ProviderError } from "./types.ts";

const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const GEMINI_DEFAULT_MODEL = "gemini-2.5-flash";

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  error?: { code?: number; message?: string; status?: string };
}

export function createGeminiProvider(apiKey: string | undefined, defaultModel = GEMINI_DEFAULT_MODEL): Provider {
  return {
    id: "gemini",
    name: "Google Gemini",
    async available() {
      return Boolean(apiKey && apiKey.length > 0);
    },
    async complete(messages: ChatMessage[], options: CompleteOptions = {}) {
      if (!apiKey) throw new ProviderError("Gemini API key missing (set GEMINI_API_KEY)", false, "gemini");
      const model = options.model ?? defaultModel;
      const system = messages.filter((m) => m.role === "system").map((m) => m.content);
      const history = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({
          role: m.role === "assistant" ? "model" : "user",
          parts: [{ text: m.content }],
        }));

      const body: Record<string, unknown> = {
        contents: history,
        generationConfig: { temperature: options.temperature ?? 0.4, maxOutputTokens: options.maxTokens ?? 2048 },
      };
      if (system.length > 0) body.systemInstruction = { parts: system.map((text) => ({ text })) };

      const res = await fetch(`${GEMINI_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options.signal,
      });
      const data = (await res.json().catch(() => ({}))) as GeminiResponse;
      if (!res.ok) {
        const msg = data.error?.message ?? `HTTP ${res.status}`;
        const canRetry = res.status === 429 || res.status === 500 || res.status === 503;
        throw new ProviderError(`gemini ${res.status}: ${msg}`, canRetry, "gemini");
      }
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new ProviderError("gemini returned empty content", true, "gemini");
      return text;
    },
  };
}