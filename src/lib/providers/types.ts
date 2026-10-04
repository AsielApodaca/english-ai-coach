export type Role = "system" | "user" | "assistant";

/**
 * Default sampling temperature applied when a caller passes none (feature 117).
 * Shared by every HTTP provider so "no option given" behaves identically
 * whichever provider answers first.
 */
export const LLM_DEFAULT_TEMPERATURE = 0.4;

/** Default response budget in tokens when a caller passes none (feature 117). */
export const LLM_DEFAULT_MAX_TOKENS = 2048;

/**
 * Characters of a raw model reply kept in error messages (feature 117).
 * Replies are "text ≥ JSON": on extraction failure the message quotes only
 * this prefix instead of the whole (possibly huge) reply.
 */
export const REPLY_SNIP_LEN = 200;

export interface ChatMessage {
  role: Role;
  content: string;
}

export interface CompleteOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
}

export type ProviderId = "gemini" | "cloudflare" | "ollama" | "ollama-fast" | "mock";

/**
 * Every known provider id (feature 117), the runtime list behind
 * `isProviderId`. The union above is the compile-time contract; this array is
 * its runtime mirror typed as `readonly ProviderId[]`, so a typo here fails
 * `tsc`, and the guard itself is pinned by `tests/api-validation.test.ts`.
 */
export const PROVIDER_IDS: readonly ProviderId[] = ["gemini", "cloudflare", "ollama", "ollama-fast", "mock"];

/**
 * Type guard for a client/env-supplied provider id (feature 117).
 *
 * `/api/practice/new`, `/api/evaluate` and `/api/chat` take an optional
 * `provider` from the JSON body and `LLM_PROVIDER` from the env — both are
 * untrusted strings. Anything unknown (typo, future model name, non-string)
 * returns false and the caller falls back to the documented default primary
 * instead of casting it to `ProviderId` blindly.
 */
export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);
}

export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  /** Whether credentials/config exist to actually call this provider. */
  available(): Promise<boolean>;
  /** Send messages and return the assistant's text reply. */
  complete(messages: ChatMessage[], options?: CompleteOptions): Promise<string>;
}

/** Error thrown by providers when a call fails. */
export class ProviderError extends Error {
  readonly canRetry: boolean;
  readonly provider: ProviderId | "unknown";

  constructor(message: string, canRetry: boolean = true, provider: ProviderId | "unknown" = "unknown") {
    super(message);
    this.name = "ProviderError";
    this.canRetry = canRetry;
    this.provider = provider;
  }
}