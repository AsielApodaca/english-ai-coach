/**
 * Health + warmup routes (features 002/007/113).
 *
 * Route contracts (moved verbatim from server.ts in feature 117):
 *   GET  /api/health — boot snapshot of every subsystem.
 *   POST /api/warmup — deduped warm of the local Ollama models.
 *
 * This module also owns the boot-warm state: `warmInFlight` used to be a
 * module-level `let` in server.ts shared by the boot call and the route; it is
 * now a closure created per `registerHealthRoutes` call (i.e. per app
 * instance), and registering the routes fires that boot warm (feature 113) so
 * the entrypoint stays `env → createApp → listen`. Timing is unchanged: the
 * kick runs while the app is being built, before `app.listen`, and it is
 * gated by `warmupEnabled(env)` exactly as before.
 *
 * Feature 119: the warm runs through `warmWithOllamaAutostart` — if a local
 * warm fails because the Ollama server is down, `ollama serve` is spawned
 * (detached, never killed) and the models are warmed once more. The launcher
 * comes from `deps.ollamaLauncher` when injected (tests) or is built here.
 * That can lengthen the warm (up to the 15 s startup budget + one re-warm),
 * but it stays fire-and-forget at boot and deduped on `POST /api/warmup`.
 */

import type { Express } from "express";

import { checkWhisper, DEFAULT_WHISPER_MODEL } from "../audio/whisper.ts";
import { providerStatus, warmupEnabled } from "../providers/index.ts";
import { createOllamaLauncher, warmWithOllamaAutostart } from "../providers/ollama-launch.ts";
import { ttsStatus } from "../audio/tts-status.ts";
import type { AppDeps } from "../app.ts";

/**
 * Register `GET /api/health` and `POST /api/warmup`.
 *
 * @param app - Express instance under construction (createApp)
 * @param deps - injected dependencies (storage, providers, rootDir, env, …)
 */
export function registerHealthRoutes(app: Express, deps: AppDeps): void {
  /**
   * Single in-flight warm batch, shared by server boot and `POST /api/warmup`:
   * an endpoint hit while the boot warm is still running joins that promise
   * instead of spawning a second batch. Reset to null on settle so a later call
   * can warm again (cheap once the models are resident).
   */
  let warmInFlight: Promise<Record<string, boolean>> | null = null;

  // Feature 119: the auto-starter used when a warm fails with the server down.
  // Injected by tests (a double that spawns nothing); the real one here.
  const launcher = deps.ollamaLauncher ?? createOllamaLauncher();

  /** Deduped warm of every local Ollama provider (never rejects). */
  function startWarmup(): Promise<Record<string, boolean>> {
    if (!warmInFlight) {
      warmInFlight = warmWithOllamaAutostart(deps.providers, launcher)
        .catch(() => ({}) as Record<string, boolean>)
        .finally(() => {
          warmInFlight = null;
        });
    }
    return warmInFlight;
  }

  // Boot warm (feature 113): pre-load the local Ollama models so the first
  // session/popup does not pay the model-load latency. Fire-and-forget — it
  // must never block or throw around `app.listen`. With feature 119 it also
  // starts `ollama serve` when the warm fails because the server is down.
  if (warmupEnabled(deps.env)) {
    const startedAt = performance.now();
    void startWarmup().then((results) => {
      for (const [id, ok] of Object.entries(results)) {
        if (ok) {
          console.log(`[warmup] ${id}: ready (${((performance.now() - startedAt) / 1000).toFixed(1)} s)`);
        } else {
          console.log(`[warmup] ${id}: failed`);
        }
      }
    });
  }

  const whisperModel = deps.env.WHISPER_MODEL ?? DEFAULT_WHISPER_MODEL;

  /**
   * GET /api/health — boot snapshot of every subsystem (features 002/007/113).
   *
   * No input. 200 →
   *   { ok: true,
   *     providers: Record<providerId, boolean>,   // availability probed live
   *     primary: string,                          // configured primary provider
   *     notes: { gemini, cloudflare },            // setup hints for the UI
   *     whisper: { available, modelReady, model, hint },
   *     tts: TtsStatus,                           // same shape as GET /api/tts/status
   *     dataDir: string }                         // absolute path of data/
   * The frontend polls it on load (STT/TTS engine choice, provider badges).
   * Errors: only an unexpected failure of the status probes → 500 { error }
   * (global /api middleware, feature 117).
   */
  app.get("/api/health", async (_req, res) => {
    const status = await providerStatus(deps.providers);
    const whisper = checkWhisper(whisperModel, deps.rootDir);
    res.json({
      ok: true,
      providers: Object.fromEntries(status),
      primary: deps.primaryProviderId,
      notes: {
        gemini: "Set GEMINI_API_KEY (free from https://aistudio.google.com/apikey).",
        cloudflare: "Uses CLOUDFLARE_API_TOKEN (+ account id auto-discovered from your opencode config).",
      },
      whisper: {
        available: whisper.available,
        modelReady: whisper.modelReady,
        model: whisper.modelName,
        hint: whisper.hint,
      },
      tts: ttsStatus(deps.env, deps.rootDir),
      dataDir: deps.storage.dataDir,
    });
  });

  /**
   * POST /api/warmup — pre-load the local Ollama models (feature 113).
   *
   * Shares the deduped in-flight warm with the boot call, so hitting this while
   * the boot warm is still running joins it instead of starting a second batch.
   * Responds 200 `{ ok: false, reason: "disabled" }` without touching Ollama
   * when `OLLAMA_WARM=0`, else 200 `{ ok, warmed: { ollama, "ollama-fast" } }`.
   * Feature 119: when a local warm fails with the server down, the response can
   * take up to the 15 s `ollama serve` startup budget plus one re-warm.
   * The frontend fires it (fire-and-forget) on app load.
   */
  app.post("/api/warmup", async (_req, res) => {
    if (!warmupEnabled(deps.env)) return res.json({ ok: false, reason: "disabled" });
    const warmed = await startWarmup();
    res.json({ ok: Object.values(warmed).every(Boolean), warmed });
  });
}
