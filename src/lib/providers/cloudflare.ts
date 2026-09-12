import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, Provider, CompleteOptions } from "./types.ts";
import { ProviderError } from "./types.ts";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
/** GLM-4.7-flash: free on Workers Free plan as of Sep 2026 (frontier GLM-5.x require paid). */
export const CLOUDFLARE_DEFAULT_MODEL = "@cf/zai-org/glm-4.7-flash";

function discoverAccountId(): string | undefined {
  const candidates = ["opencode.json", "opencode.jsonc"];
  for (const f of candidates) {
    const p = join(homedir(), ".config", "opencode", f);
    try {
      if (existsSync(p)) {
        const found = readFileSync(p, "utf8").match(/accounts\/([0-9a-f]{20,33})/i)?.[1];
        if (found) return found;
      }
    } catch {
      // try next
    }
  }
  return undefined;
}

interface CloudflareResponse {
  success?: boolean;
  errors?: { code?: number; message?: string }[];
  error?: string | { message?: string };
  result?: { choices?: { message?: { content?: string } }[] };
  choices?: { message?: { content?: string } }[];
}

export function createCloudflareProvider(
  token: string | undefined,
  accountId: string | undefined,
  defaultModel = CLOUDFLARE_DEFAULT_MODEL,
): Provider {
  let discoveredId: string | undefined;
  return {
    id: "cloudflare",
    name: "Cloudflare Workers AI",
    async available() {
      if (!token) return false;
      discoveredId = accountId ?? discoverAccountId();
      return Boolean(discoveredId);
    },
    async complete(messages: ChatMessage[], options: CompleteOptions = {}) {
      discoveredId = accountId ?? discoverAccountId();
      if (!token || !discoveredId) {
        throw new ProviderError("Cloudflare credentials missing (CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID)", false, "cloudflare");
      }
      const model = options.model ?? defaultModel;
      const res = await fetch(`${CLOUDFLARE_API}/accounts/${discoveredId}/ai/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          model,
          messages,
          temperature: options.temperature ?? 0.4,
          max_tokens: options.maxTokens ?? 2048,
        }),
        signal: options.signal,
      });
      const data = (await res.json().catch(() => ({}))) as CloudflareResponse;
      if (!res.ok || data.success === false) {
        const errText = data.error ? (typeof data.error === "string" ? data.error : data.error.message) : "";
        const msg = data.errors?.map((e) => e.message).join("; ") || errText || (data.success === false ? "unsuccessful" : `HTTP ${res.status}`);
        const canRetry = res.status === 429 || res.status >= 500;
        throw new ProviderError(`cloudflare ${res.status}: ${msg}`, canRetry, "cloudflare");
      }
      const content = data.result?.choices?.[0]?.message?.content ?? data.choices?.[0]?.message?.content;
      if (!content) throw new ProviderError("cloudflare returned empty content", true, "cloudflare");
      return content;
    },
  };
}