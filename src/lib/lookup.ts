/**
 * Lexical lookup pipeline (feature 112) behind `GET /api/lookup`.
 *
 * Resolves the word/phrase under the user's cursor into the three popover
 * fields (gloss, example, translationEs) without ever blocking the practice
 * flow. Pure and testable: every external effect — dictionaryapi.dev,
 * MyMemory, the LLM provider chain (feature 001), the cache and the retry
 * backoff — arrives through injectable deps, so the whole pipeline runs in
 * tests with fakes and zero network.
 *
 * Pipeline (first success wins; successful entries cached by normalized text):
 *   1. cache (server LRU + the client's own Map/localStorage in the browser)
 *   2. single word  → dictionaryapi.dev (gloss = 1st definition, example)
 *   3. translation  → MyMemory en|es (translationEs)
 *   4. LLM fallback (provider registry with fallback) when the text is a
 *      phrase (≥ 2 tokens, where word-by-word lookup is wrong: "shut up"),
 *      the dictionary missed (404/odd entry) or MyMemory failed.
 *
 * Conventions honored here: LLM replies are "text ≥ JSON" and parsed with
 * tolerant extraction (`extractJSON` tolerates code fences/noise); every LLM
 * prompt carries the LEARNER MEMORY block; failures are never cached as
 * success and `resolveLookup` NEVER throws — a total failure resolves to
 * `{ ok: false, error }` (the client renders "Significado no disponible").
 */

import { completeWithFallback, extractJSON } from "./providers/index.ts";
import type { Provider } from "./providers/types.ts";
import { MS_PER_MIN } from "./time.ts";

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

// ---------------------------------------------------------------------------
// Normalization / validation
// ---------------------------------------------------------------------------

/**
 * Normalize a raw selection/word into the canonical lookup key: collapse all
 * whitespace (multi-line selections included), strip edge punctuation and
 * lowercase. Returns "" for non-strings or text with no letters/digits.
 *
 * Mirrored by `normalizeLookupText` in `public/ui/lookup-popover.js` (the
 * browser needs the same key for its client cache; no build step to share it).
 *
 * @param raw - raw text (selection `.toString()`, `data-word`, query param)
 * @returns the normalized text, or "" when there is nothing to look up
 */
export function normalizeLookupText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "")
    .toLowerCase();
}

export type LookupValidation = { ok: true; text: string } | LookupFailure;

/**
 * Validate a lookup query before any external call (spec 112 "Límites"):
 * required, ≤ 60 chars before and after normalization, and karaoke-ish —
 * letters/digits with internal apostrophes/hyphens/whitespace and the
 * separators a dragged selection can carry. Arbitrary text (URLs, symbols)
 * is rejected with `ok: false` and NO network traffic.
 *
 * @param raw - the `text` query param / selected text
 */
export function validateLookupText(raw: unknown): LookupValidation {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, error: "text is required." };
  }
  if (raw.trim().length > LOOKUP_MAX_CHARS) {
    return { ok: false, error: `text exceeds ${LOOKUP_MAX_CHARS} characters.` };
  }
  const text = normalizeLookupText(raw);
  if (!text) {
    return { ok: false, error: "text has no letters or numbers." };
  }
  if (text.length > LOOKUP_MAX_CHARS) {
    return { ok: false, error: `text exceeds ${LOOKUP_MAX_CHARS} characters.` };
  }
  const first = text.charAt(0);
  const last = text.charAt(text.length - 1);
  if (!/[\p{L}\p{N}]/u.test(first) || !/[\p{L}\p{N}]/u.test(last)) {
    return { ok: false, error: "text is not a karaoke token." };
  }
  if (!/^[\p{L}\p{N}\s'’.,!?;:\-]+$/u.test(text)) {
    return { ok: false, error: "text is not a karaoke token." };
  }
  return { ok: true, text };
}

/**
 * Number of whitespace-separated tokens of a normalized text.
 * @param text - normalized lookup text
 */
export function countLookupTokens(text: string): number {
  return text.split(" ").filter(Boolean).length;
}

// ---------------------------------------------------------------------------
// Same-origin gate for GET /api/lookup
// ---------------------------------------------------------------------------

/** Request headers the cross-origin decision needs (tests fake them). */
export interface LookupRequestHeaders {
  origin?: string | readonly string[] | undefined;
  host?: string | readonly string[] | undefined;
  secFetchSite?: string | readonly string[] | undefined;
}

/** First value of a possibly repeated header, trimmed; `undefined` if none. */
function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  const raw = typeof value === "string" ? value : Array.isArray(value) ? value[0] : undefined;
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

/**
 * Cheap cross-origin decision for `GET /api/lookup` (review fix #3): a GET is
 * a CORS "simple request" (no preflight), so any web page could otherwise use
 * this local server as a free MyMemory/LLM translation proxy — the charset
 * validation does not stop a well-formed English sentence.
 *
 * Rejects when:
 *   - `Sec-Fetch-Site` is present and is not `same-origin` (cross-site
 *     `<img>`/`fetch` from another page, direct navigation), or
 *   - `Origin` is present and its host differs from the request `Host`
 *     (also covers the opaque `"null"` origin and malformed values).
 *
 * Same-origin requests (the local app) and header-less clients (curl, the
 * smoke tests) pass: browsers omit `Origin` on same-origin GETs.
 *
 * @param headers - the request's `Origin`, `Host` and `Sec-Fetch-Site`
 */
export function isSameOriginLookupRequest(headers: LookupRequestHeaders): boolean {
  const secFetchSite = firstHeader(headers.secFetchSite);
  if (secFetchSite !== undefined && secFetchSite !== "same-origin") return false;
  const origin = firstHeader(headers.origin);
  if (origin === undefined) return true; // same-origin GET / non-browser client
  const host = firstHeader(headers.host);
  if (host === undefined) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false; // opaque ("null") or malformed Origin
  }
}

/**
 * Pipeline kind from the token count (spec 112: the server decides `kind`,
 * one endpoint for both).
 * @param text - normalized lookup text
 */
export function lookupKind(text: string): LookupKind {
  return countLookupTokens(text) >= 2 ? "phrase" : "word";
}

/** Cut a string at a word boundary up to `max` chars, ellipsis included. */
function truncateAtWord(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(" ");
  const head = space > max * 0.6 ? cut.slice(0, space) : cut;
  return `${head.trimEnd()}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// ---------------------------------------------------------------------------
// dictionaryapi.dev
// ---------------------------------------------------------------------------

/**
 * Parse a dictionaryapi.dev response (`GET /api/v2/entries/en/<word>`).
 *
 * The API returns an ARRAY of entries; the gloss is the FIRST definition of
 * the first usable entry (trimmed to `GLOSS_MAX_CHARS`), the example is the
 * first definition that carries one (best effort). Returns `null` when the
 * payload holds no definition (404 bodies, odd entries), which routes the
 * lookup into the LLM fallback.
 *
 * @param data - parsed JSON body of dictionaryapi.dev
 */
export function parseDictionaryEntry(data: unknown): DictionaryHit | null {
  if (!Array.isArray(data)) return null;
  for (const item of data) {
    if (!isRecord(item) || !Array.isArray(item.meanings)) continue;
    let gloss = "";
    let example = "";
    for (const meaning of item.meanings) {
      if (!isRecord(meaning) || !Array.isArray(meaning.definitions)) continue;
      for (const def of meaning.definitions) {
        if (!isRecord(def)) continue;
        if (!gloss && typeof def.definition === "string" && def.definition.trim()) {
          gloss = truncateAtWord(def.definition.trim(), GLOSS_MAX_CHARS);
        }
        if (!example && typeof def.example === "string" && def.example.trim()) {
          example = def.example.trim();
        }
        if (gloss && example) break;
      }
      if (gloss && example) break;
    }
    if (gloss) return { gloss, example };
  }
  return null;
}

/**
 * Build the dictionary resolver on top of an injectable fetch.
 * 404s, malformed JSON and empty entries all resolve to `null` (never throw)
 * so the pipeline can fall to the LLM.
 *
 * Circuit breaker: a NETWORK failure only (timeout/abort or a fetch-level
 * `TypeError`, i.e. "fetch failed") opens the circuit for `cooldownMs` —
 * while open, calls return `null` immediately WITHOUT touching the network.
 * dictionaryapi.dev being unreachable would otherwise tax every cold word
 * with the full timeout. Application-level responses (404/other non-OK,
 * malformed bodies) return `null` inside the `try` and do NOT trip the
 * breaker: they are legitimate answers, not an outage.
 *
 * @param fetchImpl - fetch-like function (global `fetch` in production)
 * @param opts.timeoutMs - per-request budget
 * @param opts.cooldownMs - how long the circuit stays open after a network failure (default 60 s)
 * @param opts.now - clock, injectable for tests (default `Date.now`)
 */
export function createDictionaryLookup(
  fetchImpl: FetchLike,
  opts: { timeoutMs?: number; cooldownMs?: number; now?: () => number } = {},
): (word: string) => Promise<DictionaryHit | null> {
  const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS;
  const cooldownMs = opts.cooldownMs ?? MS_PER_MIN;
  const now = opts.now ?? Date.now;
  let openUntil = 0;
  return async (word: string): Promise<DictionaryHit | null> => {
    if (now() < openUntil) return null; // circuit open: skip the network entirely
    try {
      const url = `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`;
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      return parseDictionaryEntry(await res.json());
    } catch (err) {
      if (isNetworkFailure(err)) openUntil = now() + cooldownMs;
      return null;
    }
  };
}

/**
 * Network/transport-level failure worth tripping the dictionary breaker.
 * `AbortSignal.timeout` surfaces as `TimeoutError` (Node) or `AbortError`
 * (DOM-compatible name); fetch network failures surface as `TypeError:
 * fetch failed`.
 *
 * @param err - the caught error
 */
function isNetworkFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === "AbortError" || err.name === "TimeoutError" || err instanceof TypeError;
}

// ---------------------------------------------------------------------------
// MyMemory (en → es translation)
// ---------------------------------------------------------------------------

/**
 * Build the MyMemory resolver on top of an injectable fetch.
 * Returns the Spanish translation, or `null` on any failure — including
 * quota/limit answers, which MyMemory reports inside `responseData`.
 *
 * @param fetchImpl - fetch-like function (global `fetch` in production)
 * @param opts.timeoutMs - per-request budget
 */
export function createTranslationLookup(
  fetchImpl: FetchLike,
  opts: { timeoutMs?: number } = {},
): (text: string) => Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? HTTP_TIMEOUT_MS;
  return async (text: string): Promise<string | null> => {
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent("en|es")}`;
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        responseData?: { translatedText?: unknown };
        responseStatus?: unknown;
      };
      if (typeof body?.responseStatus === "number" && body.responseStatus !== 200) return null;
      const translated = body?.responseData?.translatedText;
      if (typeof translated !== "string") return null;
      const value = translated.trim();
      if (!value) return null;
      // Quota / failure notices come back as prose in the same field.
      if (/^MYMEMORY WARNING|^INVALID\b|QUERY LENGTH LIMIT|DISABLED/i.test(value)) return null;
      return value;
    } catch {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// LLM fallback (provider registry, feature 001)
// ---------------------------------------------------------------------------

const SYSTEM_LOOKUP = `You are a bilingual English-Spanish dictionary for a Spanish-speaking learner reading an English practice transcript.
Given a word or short phrase, return its meaning as strict JSON ONLY (no markdown, no commentary):
{"gloss": string, "example": string, "translationEs": string}
- gloss: the brief English meaning of the WHOLE text (max 140 chars). For a phrase or phrasal verb give the expression's meaning, never a word-by-word sum.
- example: one short natural English sentence using the text in context.
- translationEs: the natural Spanish translation. For phrasal verbs and idioms give the idiomatic Spanish equivalent, NEVER a literal word-by-word translation ("shut up" → "cállate", not "cerrar arriba").`;

/**
 * Build the LLM prompt for a lookup. The LEARNER MEMORY block (project rule)
 * is always present so the answer can sit at the learner's level.
 *
 * @param text - normalized lookup text
 * @param kind - "word" | "phrase"
 * @param learnerMemory - learner memory block from `learner.ts`
 */
export function buildLookupPrompt(
  text: string,
  kind: LookupKind,
  learnerMemory: string,
): { system: string; user: string } {
  const user = `Text: "${text}"\nKind: ${kind}\n\nLEARNER MEMORY:\n${learnerMemory}`;
  return { system: SYSTEM_LOOKUP, user };
}

/**
 * Parse an LLM reply into a `LookupEntry` with tolerant JSON extraction
 * (code fences, surrounding prose and noise are tolerated — project
 * convention). Returns `null` when no usable gloss/translation is found.
 *
 * @param reply - raw model output (text ≥ JSON)
 */
export function parseLookupLlmReply(reply: unknown): LookupEntry | null {
  if (typeof reply !== "string" || !reply.trim()) return null;
  let data: unknown;
  try {
    data = extractJSON<Record<string, unknown>>(reply);
  } catch {
    return null;
  }
  if (!isRecord(data)) return null;
  const gloss = typeof data.gloss === "string" ? data.gloss.trim() : "";
  const example = typeof data.example === "string" ? data.example.trim() : "";
  const translationEs = typeof data.translationEs === "string" ? data.translationEs.trim() : "";
  if (!gloss && !translationEs) return null;
  return {
    gloss: gloss ? truncateAtWord(gloss, GLOSS_MAX_CHARS) : "",
    example,
    translationEs,
  };
}

/**
 * Build the LLM resolver on top of the provider registry: strict JSON prompt,
 * tolerant extraction, and every failure (ProviderError, unparseable reply,
 * timeout) collapsed to `null` so the degraded path stays silent. Bounded by
 * its own timeout so a hung provider can never stall a hover.
 *
 * @param candidates - ordered provider candidates (registry fallback chain)
 * @param opts.timeoutMs - per-call budget for the whole chain
 */
export function createLlmLookup(
  candidates: LlmCandidate[],
  opts: { timeoutMs?: number } = {},
): (text: string, kind: LookupKind, learnerMemory: string) => Promise<LookupEntry | null> {
  const timeoutMs = opts.timeoutMs ?? LLM_TIMEOUT_MS;
  return async (text, kind, learnerMemory) => {
    if (candidates.length === 0) return null;
    try {
      const { system, user } = buildLookupPrompt(text, kind, learnerMemory);
      const result = await completeWithFallback(
        candidates,
        [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        { temperature: 0.2, maxTokens: LLM_MAX_TOKENS, signal: AbortSignal.timeout(timeoutMs) },
      );
      return parseLookupLlmReply(result.text);
    } catch {
      return null;
    }
  };
}

// ---------------------------------------------------------------------------
// Server cache (LRU, good entries only)
// ---------------------------------------------------------------------------

/**
 * In-memory LRU cache for successful lookups. Lexical content is stable, so
 * entries live until evicted by capacity (no TTL); errors/partials without a
 * gloss are never stored (spec 112: "errores no se cachean como éxito").
 *
 * @param maxEntries - capacity (oldest entries are evicted first)
 */
export function createLookupCache(maxEntries: number = LOOKUP_CACHE_MAX): LookupCache {
  const map = new Map<string, LookupCachePayload>();
  const capacity = Math.max(1, Math.floor(maxEntries));
  return {
    get(key: string): LookupCachePayload | undefined {
      const hit = map.get(key);
      if (!hit) return undefined;
      // Refresh recency: re-insert at the tail so it becomes the newest.
      map.delete(key);
      map.set(key, hit);
      return hit;
    },
    set(key: string, value: LookupCachePayload): void {
      map.delete(key);
      map.set(key, value);
      while (map.size > capacity) {
        const oldest = map.keys().next();
        if (oldest.done) break;
        map.delete(oldest.value);
      }
    },
    get size(): number {
      return map.size;
    },
  };
}

// ---------------------------------------------------------------------------
// Pipeline
// ---------------------------------------------------------------------------

/** Injectable effects of the pipeline; every dep fails soft (→ null). */
export interface LookupDeps {
  /** dictionaryapi.dev resolver (word → gloss/example); null on a miss. */
  dictionary?: (word: string) => Promise<DictionaryHit | null>;
  /** MyMemory resolver (text → Spanish); null on failure. */
  translate?: (text: string) => Promise<string | null>;
  /** LLM resolver (provider chain); null when every provider failed. */
  llm?: (text: string, kind: LookupKind, learnerMemory: string) => Promise<LookupEntry | null>;
  /**
   * Learner memory for the LLM prompt (project rule). Lazy so cache hits and
   * non-LLM paths never touch storage.
   */
  getLearnerMemory?: () => string;
  /** Shared server cache (successes only). `null` disables it. */
  cache?: LookupCache | null;
  /** Backoff before the single retry of a failed attempt (0 = none). */
  retryDelayMs?: number;
  /** Injected sleep so tests run the retry instantly. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Total end-to-end budget (review fix #8). When the whole attempt+retry
   * chain exceeds it, `{ ok: false, error: LOOKUP_UNAVAILABLE }` is returned
   * right away instead of leaving the client in "cargando…". The in-flight
   * chain keeps running and may still warm the cache for the next attempt.
   * `0` disables the deadline (used by tests that control timing themselves).
   */
  deadlineMs?: number;
}

/** Run one pass of the pipeline; every dep is wrapped so nothing throws. */
async function runAttempt(
  text: string,
  kind: LookupKind,
  io: Required<Pick<LookupDeps, "dictionary" | "translate" | "llm" | "getLearnerMemory">>,
): Promise<LookupResult> {
  const safe = async <T>(fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch {
      return null;
    }
  };

  // Phrase (≥ 2 tokens): straight to the LLM — word-by-word resolution is
  // exactly what fails for phrasals/idioms ("shut up" ≠ "cerrar" + "arriba").
  if (kind === "phrase") {
    const fromLlm = await safe(() => io.llm(text, kind, io.getLearnerMemory()));
    if (fromLlm) return { ok: true, kind, source: "llm", entry: fromLlm };
    const translated = await safe(() => io.translate(text));
    if (translated) {
      return { ok: true, kind, source: "mymemory", entry: { gloss: "", example: "", translationEs: translated } };
    }
    return { ok: false, error: LOOKUP_UNAVAILABLE };
  }

  // Word: dictionary (gloss + example) → MyMemory (translation) → LLM.
  const dict = await safe(() => io.dictionary(text));
  if (dict?.gloss) {
    const translated = await safe(() => io.translate(text));
    if (translated) {
      return {
        ok: true,
        kind,
        source: "dictionary",
        entry: { gloss: dict.gloss, example: dict.example, translationEs: translated },
      };
    }
    // MyMemory failed → LLM fallback (spec 112); if that fails too, keep the
    // dictionary gloss and degrade the translation to empty (still useful).
    const fromLlm = await safe(() => io.llm(text, kind, io.getLearnerMemory()));
    if (fromLlm) return { ok: true, kind, source: "llm", entry: fromLlm };
    return {
      ok: true,
      kind,
      source: "dictionary",
      entry: { gloss: dict.gloss, example: dict.example, translationEs: "" },
    };
  }

  // Dictionary miss (404 / odd entry) → LLM fallback (spec 112).
  const fromLlm = await safe(() => io.llm(text, kind, io.getLearnerMemory()));
  if (fromLlm) return { ok: true, kind, source: "llm", entry: fromLlm };
  // Last resort: at least the Spanish translation.
  const translated = await safe(() => io.translate(text));
  if (translated) {
    return { ok: true, kind, source: "mymemory", entry: { gloss: "", example: "", translationEs: translated } };
  }
  return { ok: false, error: LOOKUP_UNAVAILABLE };
}

/**
 * Resolve a lookup query end to end. NEVER throws: validation failures and
 * total source failures come back as `{ ok: false, error }`.
 *
 * Order: validate (no external call on rejection) → cache → pipeline → at
 * most ONE retry with a short backoff → cache the success. Cached responses
 * are reported with `source: "cache"` (the entry itself is stored as first
 * resolved, so `kind` stays accurate).
 *
 * @param rawText - raw query text (selection / word / `?text=` param)
 * @param deps - injectable effects (fakes in tests, HTTP/LLM in the server)
 */
export async function resolveLookup(rawText: unknown, deps: LookupDeps = {}): Promise<LookupResult> {
  const validation = validateLookupText(rawText);
  if (!validation.ok) return validation;
  const text = validation.text;
  const kind = lookupKind(text);

  const cache = deps.cache ?? null;
  const hit = cache?.get(text);
  if (hit) return { ok: true, kind: hit.kind, source: "cache", entry: hit.entry };

  const io = {
    dictionary: deps.dictionary ?? (async (): Promise<DictionaryHit | null> => null),
    translate: deps.translate ?? (async (): Promise<string | null> => null),
    llm: deps.llm ?? (async (): Promise<LookupEntry | null> => null),
    getLearnerMemory: deps.getLearnerMemory ?? ((): string => ""),
  };
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const pipeline = (async (): Promise<LookupResult> => {
    let result = await runAttempt(text, kind, io);
    if (!result.ok) {
      // Spec 112: at most one retry with a short backoff, never a retry loop.
      const delay = deps.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
      if (delay > 0) await sleep(delay);
      result = await runAttempt(text, kind, io);
    }

    // Cache COMPLETE successes only (review fix #5): a gloss-less partial
    // (MyMemory-only degrade), a translation-less partial (dictionary hit whose
    // translation failed) and `ok: false` are transient — caching them would
    // freeze the missing field forever instead of letting the next attempt
    // heal it.
    if (result.ok && result.entry.gloss && result.entry.translationEs && cache) {
      cache.set(text, { kind: result.kind, source: result.source, entry: result.entry });
    }
    return result;
  })();

  // Total deadline (review fix #8): race the pipeline against the budget so a
  // worst-case chain (~45 s of stacked timeouts) cannot hold the card in
  // "cargando…". The loser's handlers stay attached (no unhandled rejection);
  // if the pipeline eventually wins after expiry it still warms the cache.
  const deadlineMs = deps.deadlineMs ?? LOOKUP_DEADLINE_MS;
  if (!(deadlineMs > 0)) return pipeline;
  return await raceDeadline(pipeline, deadlineMs);
}

/**
 * Resolve `pipeline` within `deadlineMs`, or the degraded failure when the
 * budget expires first.
 *
 * @param pipeline - the end-to-end attempt+retry chain (never rejects)
 * @param deadlineMs - total budget in ms
 */
async function raceDeadline(pipeline: Promise<LookupResult>, deadlineMs: number): Promise<LookupResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<LookupResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: LOOKUP_UNAVAILABLE }), deadlineMs);
  });
  try {
    return await Promise.race([pipeline, expired]);
  } finally {
    clearTimeout(timer);
  }
}
