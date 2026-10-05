/**
 * External sources of the lookup pipeline (feature 112) — split out of
 * `lookup.ts` by feature 117: dictionaryapi.dev, MyMemory and the LLM
 * fallback.
 *
 * Every network effect arrives through an injectable fetch/candidate list,
 * so the whole file runs in tests with fakes and zero network. Failures are
 * collapsed to `null` (never thrown) so the pipeline falls through to the
 * next source.
 */

import { completeWithFallback, extractJSON } from "../providers/index.ts";
import { MS_PER_MIN } from "../time.ts";
import {
  GLOSS_MAX_CHARS,
  type DictionaryHit,
  type FetchLike,
  type LookupEntry,
  type LookupKind,
  type LlmCandidate,
} from "./lookup-types.ts";

/**
 * Per-call network budgets (ms) so a stuck source can never block a hover.
 * dictionaryapi.dev is unreachable from this network (it always times out),
 * so the HTTP budget is capped at 2.5 s — the maximum stall a hover pays
 * before the pipeline falls through to the next source.
 */
const HTTP_TIMEOUT_MS = 2500;
const LLM_TIMEOUT_MS = 12000;
const LLM_MAX_TOKENS = 400;

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
