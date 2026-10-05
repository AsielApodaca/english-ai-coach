# 119 · Auto-start Ollama when the local warm fails — Tasks

- [x] Create `src/lib/providers/ollama-launch.ts` with `createOllamaLauncher()` (closure state, `detached`+`unref` spawn, ping poll with budget, ENOENT/spawn-error/timeout paths, never rejects).
- [x] Export `warmWithOllamaAutostart(providers, launcher)` from the same module (warm → server down → launch → re-warm once; server up → keep the failure).
- [x] Wire it into `startWarmup()` in `src/lib/routes/health.ts` behind `deps.ollamaLauncher ?? createOllamaLauncher()`, keeping the `warmInFlight` dedup and the `warmupEnabled(env)` gate.
- [x] Add the optional `AppDeps.ollamaLauncher?: OllamaLauncher` field in `src/lib/app.ts` (documented contract).
- [x] Tests `tests/ollama-launch.test.ts`: already-up (no spawn), spawn+poll to ready, ENOENT hint, generic spawn error, budget timeout, concurrent dedup (single spawn), and the four `warmWithOllamaAutostart` scenarios plus the no-local-provider case.
- [x] Test `tests/app-http.test.ts`: `POST /api/warmup` on a real `createApp` consults the injected launcher exactly once and answers with the re-warm result.
- [x] Update `spec/` (this folder) and add the roadmap entry in `../../constitution/roadmap.md`.
- [x] Document the behaviour in `README.md` and the `OLLAMA_WARM` opt-out in `.env.example`.
- [x] Run `npm run check` and `npm test` until green.
- [ ] Manual: Ollama installed but stopped → boot → `[ollama] starting … ready` logs → first local session works.
