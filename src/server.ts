/**
 * Entry point (feature 117): env → singletons → createApp → listen.
 *
 * This module is the ONLY place that opens a port; importing it starts the
 * server, which is why nothing else ever imports it (tests build their app
 * through `src/lib/app.ts`, whose import is side-effect free).
 *
 * The boot warm of the local Ollama models (feature 113) is fired while the
 * routes are registered — see `registerHealthRoutes` (lib/routes/health.ts),
 * which owns the deduped in-flight batch shared with `POST /api/warmup`.
 */

import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createApp } from "./lib/app.ts";
import { buildProviders } from "./lib/providers/index.ts";
import { isProviderId, type ProviderId } from "./lib/providers/types.ts";
import { createRefinementRegistry } from "./lib/refinement.ts";
import { createLookupCache } from "./lib/lookup.ts";
import { createStorage } from "./lib/session/storage.ts";
import { createTtsCache } from "./lib/tts-cache.ts";
import { checkWhisper, DEFAULT_WHISPER_MODEL } from "./lib/whisper.ts";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const env = process.env as NodeJS.ProcessEnv;

const providers = buildProviders(env as never);
/**
 * Primary provider: `LLM_PROVIDER` when it names a real provider, otherwise
 * the mock (MOCK_LLM=1) or the documented default `cloudflare` (feature 117 —
 * a bogus env value falls back instead of poisoning the chain).
 */
const primaryProviderId: ProviderId = isProviderId(env.LLM_PROVIDER)
  ? env.LLM_PROVIDER
  : env.MOCK_LLM
    ? "mock"
    : "cloudflare";

/** TEMPORARY: MOCK_LLM=1 short-circuits every LLM call with canned replies. */
const MOCK_LLM = Boolean(env.MOCK_LLM);

const storage = createStorage(rootDir);

/**
 * Shared synthesis cache for `/api/tts` (feature 114): the same line asked
 * again (retries, loops, word clicks) is served byte-identical and instantly
 * instead of being re-synthesized — re-synthesis is what made repeats
 * "crackle". Lives under `data/tmp/tts-cache/` (git-ignored, disposable);
 * building it also purges entries past the 24 h TTL (purge on boot).
 */
const ttsCache = createTtsCache({ dir: join(rootDir, "data", "tmp", "tts-cache") });

/**
 * In-memory registry of the background refinements launched by
 * `POST /api/attempt`. TTL-purged on access (60 s) and capped, so a long
 * practice session can never grow it without bound; entries live only in
 * memory — restarting the server makes pending ids 404 (the client keeps its
 * deterministic paint).
 */
const refinements = createRefinementRegistry();

/** Shared LRU cache for /api/lookup — one entry per normalized text. */
const lookupCache = createLookupCache();

const app = createApp({ storage, providers, primaryProviderId, ttsCache, refinements, lookupCache, rootDir, env });

const port = Number(env.PORT ?? 3000);
const server = app.listen(port, () => {
  console.log(`English AI Coach running at http://localhost:${port}`);
  console.log(`LLM primary: ${primaryProviderId} · provider count: ${providers.length}`);
  if (MOCK_LLM) console.log("⚠ MOCK_LLM=1 — LLM calls return canned replies (provider 'mock'). Remove it for real practice.");
  console.log(`Whisper: ${checkWhisper(env.WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL, rootDir).hint}`);
});
