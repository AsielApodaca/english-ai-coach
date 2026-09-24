export type Role = "system" | "user" | "assistant";

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

export type ProviderId = "gemini" | "cloudflare" | "ollama" | "mock";

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