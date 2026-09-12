import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, Provider, CompleteOptions } from "./types.ts";
import { ProviderError } from "./types.ts";

export const ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const ZEN_DEFAULT_MODEL = "big-pickle";

const OPCODE_AUTH_PATH = join(homedir(), ".local", "share", "opencode", "auth.json");

function loadZenKey(envKey: string | undefined): string | undefined {
  if (envKey && envKey.length > 0) return envKey;
  try {
    if (existsSync(OPCODE_AUTH_PATH)) {
      const raw = readFileSync(OPCODE_AUTH_PATH, "utf8");
      const data = JSON.parse(raw) as Record<string, { key?: string; type?: string }>;
      const key = data["opencode"]?.key;
      if (key && key.length > 0) return key;
    }
  } catch {
    // fall through to unavailable
  }
  return undefined;
}

async function rawBody(res: Response): Promise<string> {
  const text = await res.text();
  if (!res.ok) {
    const detail = (() => {
      try {
        return JSON.parse(text);
      } catch {
        return { raw: text.slice(0, 300) };
      }
    })();
    const canRetry = res.status === 429 || res.status === 502 || res.status === 503 || res.status >= 500;
    throw new ProviderError(`zen ${res.status}: ${JSON.stringify(detail).slice(0, 400)}`, canRetry, "zen");
  }
  return text;
}

export function createZenProvider(envKey: string | undefined, baseUrl = ZEN_BASE_URL, defaultModel = ZEN_DEFAULT_MODEL): Provider {
  let key = loadZenKey(envKey);

  async function currentKey(): Promise<string | undefined> {
    key = loadZenKey(envKey) ?? key;
    return key;
  }

  return {
    id: "zen",
    name: "OpenCode Zen",
    async available() {
      return Boolean(await currentKey());
    },
    async complete(messages: ChatMessage[], options: CompleteOptions = {}) {
      const apiKey = await currentKey();
      if (!apiKey) throw new ProviderError("OpenCode Zen key not found (auth.json or ZEN_API_KEY)", false, "zen");
      const model = options.model ?? defaultModel;
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.4,
          max_tokens: options.maxTokens ?? 2048,
        }),
        signal: options.signal,
      });
      const body = await rawBody(res);
      try {
        const data = JSON.parse(body) as { choices?: { message?: { content?: string } }[] };
        const content = data.choices?.[0]?.message?.content;
        if (typeof content !== "string" || content.length === 0) {
          throw new ProviderError(`zen returned empty content (model=${model})`, true, "zen");
        }
        return content;
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        throw new ProviderError(`zen unparseable response: ${body.slice(0, 300)}`, true, "zen");
      }
    },
  };
}