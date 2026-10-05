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

/**
 * Implementation lives in the split modules below (feature 117); this file
 * is the public entry point and re-exports the whole contract, so callers
 * only ever import `lib/lookup/lookup.ts` (feature 118).
 */
export * from "./lookup-types.ts";
export * from "./lookup-validate.ts";
export * from "./lookup-providers.ts";
export * from "./lookup-resolve.ts";
