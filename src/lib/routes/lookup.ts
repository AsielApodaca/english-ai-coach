/**
 * Lexical lookup popover route (feature 112).
 *
 * Route contract (JSDoc block moved verbatim from server.ts in feature 117):
 *   GET /api/lookup?text=<phrase> — dictionary/translation/LLM lookup behind
 *   the karaoke popover, with a same-origin gate.
 */

import type { Express } from "express";

import {
  createDictionaryLookup,
  createLlmLookup,
  createTranslationLookup,
  isSameOriginLookupRequest,
  resolveLookup,
  validateLookupText,
} from "../lookup.ts";
import { buildLearnerMemory } from "../practice/learner.ts";
import { lookupCandidates } from "./chain.ts";
import type { AppDeps } from "../app.ts";

/**
 * Register `GET /api/lookup`.
 *
 * @param app - Express instance under construction (createApp)
 * @param deps - injected dependencies (storage, providers, lookupCache, …)
 */
export function registerLookupRoutes(app: Express, deps: AppDeps): void {
  // dictionaryapi.dev + MyMemory resolvers (built once per app, keys never inline).
  const lookupDictionary = createDictionaryLookup(fetch);
  const lookupTranslate = createTranslationLookup(fetch);

  /**
   * GET /api/lookup?text=<phrase> — word/phrase lookup behind the karaoke
   * popover (feature 112).
   *
   * Response: `{ ok: true, kind: "word"|"phrase", source: "dictionary"|"mymemory"|"llm"|"cache",
   *             entry: { gloss, example, translationEs } }`
   *        or `{ ok: false, error }` (400 when the input is not a valid ≤60-char
   *            karaoke token — rejected with NO external call; 502 when every
   *            source failed, i.e. the degraded mode the client renders as
   *            "Significado no disponible"). The practice flow is never blocked.
   *
   * The pipeline (cache → dictionaryapi.dev → MyMemory → LLM fallback through
   * the provider registry) lives in `lib/lookup.ts` and never throws. Learner
   * memory is provided lazily, so cache hits don't touch storage at all.
   */
  app.get("/api/lookup", async (req, res) => {
    // Cheap cross-origin gate (review fix #3): GET is a CORS simple request, so
    // without this any web page could use the local server as a free
    // translation/LLM proxy. Same-origin app requests and header-less clients
    // (curl) keep working.
    if (!isSameOriginLookupRequest({
      origin: req.headers.origin,
      host: req.headers.host,
      secFetchSite: req.headers["sec-fetch-site"],
    })) {
      return res.status(403).json({ ok: false, error: "cross-origin lookup requests are not allowed." });
    }
    const text = typeof req.query.text === "string" ? req.query.text : "";
    const validation = validateLookupText(text);
    if (!validation.ok) return res.status(400).json({ ok: false, error: validation.error });
    try {
      const result = await resolveLookup(validation.text, {
        dictionary: lookupDictionary,
        translate: lookupTranslate,
        // The provider chain is resolved per call so MOCK_LLM/primary selection
        // keeps working exactly like every other endpoint — except that the
        // lookup popup always uses real providers (`lookupCandidates`).
        llm: (query, kind, memory) => createLlmLookup(lookupCandidates(deps))(query, kind, memory),
        getLearnerMemory: () => buildLearnerMemory(deps.storage.loadProfile(), deps.storage.loadAllSessions()),
        cache: deps.lookupCache,
      });
      if (!result.ok) return res.status(502).json({ ok: false, error: result.error });
      res.json(result);
    } catch (err) {
      // Defensive: resolveLookup is total, but a lookup must never break the flow.
      res.status(502).json({ ok: false, error: (err as Error).message });
    }
  });
}
