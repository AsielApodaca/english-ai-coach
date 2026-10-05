/**
 * End-to-end lookup pipeline (feature 112) — split out of `lookup.ts` by
 * feature 117. `resolveLookup` NEVER throws: validation failures and total
 * source failures come back as `{ ok: false, error }` (the client renders
 * "Significado no disponible").
 *
 * Order: validate (no external call on rejection) → cache → pipeline → at
 * most ONE retry with a short backoff → cache the success → total deadline.
 */

import {
  DEFAULT_RETRY_DELAY_MS,
  LOOKUP_CACHE_MAX,
  LOOKUP_DEADLINE_MS,
  LOOKUP_UNAVAILABLE,
  type DictionaryHit,
  type LookupCache,
  type LookupCachePayload,
  type LookupEntry,
  type LookupKind,
  type LookupResult,
} from "./lookup-types.ts";
import { lookupKind, validateLookupText } from "./lookup-validate.ts";

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
