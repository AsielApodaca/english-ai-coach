/**
 * Lookup domain types and limits (feature 112) — split out of `lookup.ts` by
 * feature 117 so every lookup module stays under the 300-line limit.
 *
 * This file is the contract side of the pipeline: the named limits
 * (`LOOKUP_MAX_CHARS`, `GLOSS_MAX_CHARS`, `LOOKUP_DEADLINE_MS`, …), the
 * `GET /api/lookup` response shapes (`LookupResult`), the injectable fetch
 * (`FetchLike`) and the server cache interface. No behaviour lives here.
 */

import type { Provider } from "./providers/types.ts";

/** Hard cap on the queried text (spec 112: this is not a free-translation API). */
export const LOOKUP_MAX_CHARS = 60;

/** Gloss cut length (spec 112: first definition trimmed to ~140 chars). */
export const GLOSS_MAX_CHARS = 140;

/** Backoff before the single retry of a failed resolution (spec 112: max 1). */
export const DEFAULT_RETRY_DELAY_MS = 250;

/**
 * Total budget for one lookup, end to end (review fix #8): without it the
 * worst case (dictionary timeout + MyMemory timeout + LLM timeout + retry)
 * could keep the card in "cargando…" for ~45 s. On expiry the degraded
 * `{ ok: false }` answer is returned promptly; a pipeline that finishes
 * later still warms the cache for the next attempt.
 */
export const LOOKUP_DEADLINE_MS = 9000;

/** Default capacity of the server LRU cache (good entries have no TTL). */
export const LOOKUP_CACHE_MAX = 256;

/**
 * Per-call network budgets (ms) so a stuck source can never block a hover.
 * dictionaryapi.dev is unreachable from this network (it always times out),
 * so the HTTP budget is capped at 2.5 s — the maximum stall a hover pays
 * before the pipeline falls through to the next source.
 */
const HTTP_TIMEOUT_MS = 2500;
const LLM_TIMEOUT_MS = 12000;
const LLM_MAX_TOKENS = 400;

/** Degraded message returned when every source failed (client renders it). */
export const LOOKUP_UNAVAILABLE = "Meaning not available right now.";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The three fields the popover renders. */
export interface LookupEntry {
  /** Brief English meaning (≤ ~140 chars). */
  gloss: string;
  /** English example sentence with the text in context. */
  example: string;
  /** Natural Spanish translation (idiomatic for phrases). */
  translationEs: string;
}

/** `word` = one token (dictionary path), `phrase` = ≥ 2 tokens (LLM path). */
export type LookupKind = "word" | "phrase";

/** Which source produced the entry (spec 112 response contract). */
export type LookupSource = "dictionary" | "mymemory" | "llm" | "cache";

export interface LookupSuccess {
  ok: true;
  kind: LookupKind;
  source: LookupSource;
  entry: LookupEntry;
}

export interface LookupFailure {
  ok: false;
  error: string;
}

export type LookupResult = LookupSuccess | LookupFailure;

/** Minimal response surface the HTTP sources need (tests fake it). */
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Injectable fetch — the global `fetch` satisfies this structurally. */
export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<HttpResponse>;

/** Candidate shape of the provider registry (same as `Candidate` in practice.ts). */
export type LlmCandidate = Pick<Provider, "id" | "available" | "complete">;

/** Dictionary hit: English gloss + example (MyMemory supplies the ES part). */
export interface DictionaryHit {
  gloss: string;
  example: string;
}

/** Cached payload of a successful lookup (kind/source as first resolved). */
export interface LookupCachePayload {
  kind: LookupKind;
  source: LookupSource;
  entry: LookupEntry;
}

/** Simple LRU map for successful lookups only (errors are never stored). */
export interface LookupCache {
  get(key: string): LookupCachePayload | undefined;
  set(key: string, value: LookupCachePayload): void;
  readonly size: number;
}