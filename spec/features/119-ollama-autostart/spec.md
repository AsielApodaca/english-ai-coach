# 119 · Auto-start Ollama when the local warm fails

**Status:** done ✅

## What it does

At server boot (and on `POST /api/warmup`) the local Ollama models are warmed as before. If that warm fails **because the Ollama server is down**, the app now spawns `ollama serve` itself (`detached` + `unref`), waits up to 15 s for the health ping to answer, and warms the models once more so the boot warm still pre-loads the weights. `ollama serve` is never killed by the app: it intentionally outlives the process (and every `node --watch` restart), so the next boot finds it via the ping and does not spawn a duplicate.

The trigger is the warm, not the request path: a warm failure while the server answers the ping means the model was never pulled (`ollama pull`) — launching would not help — while a dead server is exactly what spawning fixes.

## Why

- **Zero-config local LLM:** on a machine where the user never typed `ollama serve`, the local provider used to be permanently unavailable (chain falls through to a 502/500/offline answer) even though Ollama is installed.
- **No surprise starts:** the auto-start only runs when the warm already wanted Ollama, so a Gemini/Cloudflare-only setup never spawns a local daemon.
- **No new knobs:** the existing `OLLAMA_WARM=0` opt-out disables the warm and therefore this trigger; there is no separate setting or env var.

## Acceptance criteria

- [x] `createOllamaLauncher()` builds an isolated launcher (closure state, no module-level `let`): `isUp()` pings, `ensureRunning()` spawns `ollama serve` at most once and resolves true only when the ping answers. It never rejects (missing binary, spawn error and startup timeout all resolve to false).
- [x] The child is spawned `{ detached: true, stdio: "ignore" }` and `unref()`'d — it is never killed by the app; concurrent `ensureRunning()` calls join one in-flight launch (single spawn).
- [x] `warmWithOllamaAutostart(providers, launcher)`: warm fails + server down → launch → re-warm once; warm fails + server up → no launch; warm ok → launcher never consulted. It never rejects.
- [x] `registerHealthRoutes` consults `deps.ollamaLauncher` when injected (tests) and builds the real one otherwise; both the boot warm and `POST /api/warmup` go through it, still deduped by `warmInFlight`.
- [x] `OLLAMA_WARM=0` still skips the warm and the auto-start entirely.
- [x] ENOENT logs an install hint; other spawn errors log `snip(message)`; timeout logs a give-up line — all prefixed `[ollama]`.
- [x] `AppDeps.ollamaLauncher` is optional and documented; no route/endpoint contract changed.
- [x] Tests: launcher unit tests (already up / spawn+poll / ENOENT / spawn error / budget timeout / concurrent dedup), `warmWithOllamaAutostart` scenarios (server up = model missing, down+started, down+failed, no local provider) and an HTTP test proving `POST /api/warmup` consults the injected launcher and re-warms (`tests/ollama-launch.test.ts`, `tests/app-http.test.ts`).
- [x] `npm run check` and `npm test` green.
- [ ] Manual: with Ollama installed but stopped, boot the app and confirm the `[ollama] starting … ready` lines, then that the first practice session hits the local provider.

## Out of scope

- Auto-**pulling** a missing model (`ollama pull <model>`): needs network and a model choice; health/warm keep reporting that failure instead.
- Starting Ollama from the request path (`completeWithFallback`) when a request arrives with the server down and the warm disabled.
- Configurable host/port (`OLLAMA_HOST`/`OLLAMA_PORT`): the base URL is still the fixed `http://localhost:11434/v1`.
- Killing the spawned server on app exit (explicitly rejected: the daemon outlives the app).
- The known gap that `settings.provider` is not wired into the provider chain.
