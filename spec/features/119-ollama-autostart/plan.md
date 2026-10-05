# 119 · Auto-start Ollama when the local warm fails — Plan

## Approach

Reuse the only signal that already means "Ollama should be running right now": the boot warm. When the warm of the local models fails, ask the health ping why — a dead server gets fixed by spawning `ollama serve`, an answering server means the model is missing and is left alone. The warm is fire-and-forget at boot and deduped with `POST /api/warmup`, so the auto-start inherits both properties.

## Implementation

1. `src/lib/providers/ollama-launch.ts` (new) — `createOllamaLauncher(opts?)` → `{ isUp(), ensureRunning() }`:
   - state in a closure (pattern of `warmInFlight` in `routes/health.ts`), one in-flight launch shared by concurrent callers;
   - `spawn("ollama", ["serve"], { detached: true, stdio: "ignore" })` + `unref()`, then poll `pingOllama()` every 500 ms up to 15 s; `error` event → ENOENT hint / `snip(message)`; never rejects.
   - `warmWithOllamaAutostart(providers, launcher)`: warm → local failure? → `isUp()` true → keep the failure (model missing); `isUp()` false → `ensureRunning()` → re-warm once.
2. `src/lib/routes/health.ts` — `startWarmup()` now runs `warmWithOllamaAutostart(deps.providers, launcher)` with `launcher = deps.ollamaLauncher ?? createOllamaLauncher()`; `warmInFlight` dedup, boot kick and `warmupEnabled(env)` gate unchanged.
3. `src/lib/app.ts` — optional `AppDeps.ollamaLauncher?: OllamaLauncher` so tests inject a double that spawns nothing.
4. `tests/ollama-launch.test.ts` (new) — launcher unit tests with injected ping/spawn (no network, no processes) plus the `warmWithOllamaAutostart` scenarios.
5. `tests/app-http.test.ts` — HTTP test: real `createApp` with an injected launcher double proves `POST /api/warmup` consults it exactly once and returns the re-warm result.
6. Docs: this folder, roadmap entry, `README.md` note, `.env.example` `OLLAMA_WARM` comment.

## Decisions

- **Trigger = the warm, not the request path** — the warm is the only place that already says "I need Ollama now"; starting the daemon from `completeWithFallback` would spawn it on a live request and stall it by up to 15 s.
- **Never kill the child (`detached` + `unref`)** — chosen explicitly over kill-on-exit: `node --watch` restarts the app constantly and would kill/restart the daemon; a persistent daemon makes every subsequent boot instant. Duplicate spawns are impossible because the ping runs before every spawn.
- **Always on, no new setting** — the existing `OLLAMA_WARM=0` is the opt-out (it disables the warm, hence the trigger). Consistent with "no knobs unless the project already has them".
- **15 s budget / 500 ms poll as named constants** — matches how long `ollama serve` takes to open the port on a cold start; on timeout the warm keeps its failure and the endpoints keep their current 502/500/offline contracts (no new status codes).
- **Re-warm after a successful launch** — otherwise the "boot warm" would have been wasted exactly on the machine that needed it most.
- **Injected launcher over module mocking** — `node:test` cannot cleanly mock ESM named imports; an optional `AppDeps` field follows the DI style `createApp` already uses.

## Risks

- **Ollama desktop app / launchd already manages the daemon** — mitigated: the ping runs first, so nothing is spawned when the server is up.
- **Port 11434 held by something else** — the ping answers and we never spawn; if it does not answer, the spawn error is logged and the warm fails exactly as today.
- **Model missing ≠ server down** — unchanged behaviour: the warm still reports `false`; auto-start deliberately does not hide it.
- **`POST /api/warmup` can now take up to ~15 s + one model load** — only when the server was down; the frontend already fires it fire-and-forget, and the boot call never blocks `app.listen`.
- **Orphan `ollama serve` after the app exits** — intentional and documented here and in the module contract.
