# 117 · Backend legible para IA (refactor de convenciones) — Tareas

## Fase 0 — Gate de tipos

- [x] Añadir `npx tsc --noEmit` al script `check` de `package.json` (conservar el `node --check` de `public/*.js`).
- [x] Corregir los 9 errores `tsc` sin `any` ni `@ts-ignore`: `align.ts:399,406` (`Array<boolean>`), `extract-files.test.ts:346-348`, `karaoke-color.test.ts:50`, `recorder-wave.test.ts:6`, `settings.test.ts:175`, `stt.test.ts:39`.
- [x] Test que falle si se quita `tsc` del script `check`.

## Fase 1 — Contratos HTTP

- [x] Middleware de errores para `/api` → `{ error: string }` (excepciones + JSON malformado) y 404 `{ error }` para rutas `/api/*` desconocidas.
- [x] JSDoc de contrato (shape entrada/salida/errores) en las 10 rutas sin documentar: health, practice/new, evaluate, session/save, next-step, history, profile, transcribe, whisper/status, chat.
- [x] Confirmar que se preservan los campos extra documentados (`ok` de lookup 112, `code` 002/007, `hint` 007); actualizar `spec/` si algún shape cambia.

## Fase 2 — Validación de entrada

- [x] `session/save`: ignorar `id` del cliente (generar `randomUUID()` server-side), validar tipos de `question`/`fullAnswer`, `saveSession` dentro de `try`. Verificar antes el uso en `public/`.
- [x] `session/checkpoint`: `isSessionEval` guard en `storage.ts`, validar `fullAttempt.words`, `saveSession` dentro de `try`.
- [x] `chat`: `CHAT_MAX_CHARS = 4000` → 400 `{ error }`.
- [x] `transcribe`: validar cabecera RIFF/WAV antes de escribir a disco y spawnear whisper.
- [x] `isProviderId` en `providers/types.ts`; sustituir el cast `as ProviderId` en `candidates()`/`lookupCandidates()`.
- [x] Validar formato de `sessionId`/`fragmentId` (`/^[a-zA-Z0-9-]+$/`) en `/api/attempt` y `/api/evaluate`.

## Fase 3 — Partir server.ts (movimiento puro)

- [x] `createApp(deps: AppDeps): Express` separado de `app.listen`; `server.ts` solo env + listen + warmup.
- [x] Eliminar `let warmInFlight` → estado en closure.
- [x] Mover `persistAttempt` → `src/lib/attempt-persist.ts` (nuevo, con test); `patchFullEval` → `refinement.ts`; `ttsStatus`/`clampNumber`/`queryList` → `src/lib/tts-status.ts`; `avgSessionScore` → `storage.ts`.
- [x] Crear `src/lib/routes/{health,practice,session,profile,audio,chat,lookup,files}.ts` con `registerXxxRoutes(app, deps)` + JSDoc.
- [x] `server.ts` <300 líneas; `npm test` + smoke manual en verde (sin cambios de comportamiento).

## Fase 4 — Tests

- [x] Tests unitarios de los 5 providers: `available()`, `complete()` con fetch fake, no-2xx → `ProviderError`/`canRetry`, `extractJSON` tolerante a code fences, abort/timeout.
- [x] Tests HTTP sobre `createApp(depsFakes)` con `app.listen(0)` + `fetch` (sin deps nuevas): health 200, session/save no sobrescribe con id de cliente, body malformado → `{ error }` (nunca HTML), 404 `/api/*`, chat > `CHAT_MAX_CHARS` → 400, checkpoint eval inválido → 400.
- [x] Aislar el `process.env` mutation de `tests/coach.test.ts` en try/finally.

## Fase 5 — Constantes nombradas

- [x] Nuevo `src/lib/subprocess.ts`: `SUBPROCESS_TIMEOUT_MS`, `SUBPROCESS_MAX_BUFFER`, `STDERR_SNIP_LEN` + `snip()`; consumir en `whisper.ts`, `piper.ts`, `edge-tts.ts`.
- [x] `providers/types.ts`: `LLM_DEFAULT_TEMPERATURE`, `LLM_DEFAULT_MAX_TOKENS`; `REPLY_SNIP_LEN` en `providers/index.ts`/`ollama.ts`.
- [x] `MS_PER_S` en `whisper.ts`; `LEVEL_UP_AVG`/`LEVEL_DOWN_AVG` en `learner.ts`; `MIN_LANG_WORDS`/`DOC_CHAR_BUDGET`/`EXTRACT_LLM_*` en `extract.ts`.
- [x] Unificar umbral de pass: `DEFAULT_PASS_THRESHOLD` única fuente para `practice.ts:327,336` (verificar sentido de import `cu2 ↔ practice` y el cableado de `passThreshold`); `LEXICAL_WEIGHT`/`NATURALNESS_WEIGHT`.
- [x] `renameSync` al import estático de `whisper.ts` (quitar dynamic import de :79).
- [x] Tests que hardcodeen estos valores pasan a importar la constante.

## Fase 6 — Split de módulos >300 líneas

- [x] `lookup.ts` (698) → `lookup-types` / `lookup-validate` / `lookup-providers` / `lookup-resolve`.
- [x] `storage.ts` (653) → `session-types` / `storage-session` / `storage-profile` (exports idénticos; commit propio).
- [x] `piper.ts` (542) → `piper-voices` + `piper`.
- [x] `align.ts` (438) → `align-words` / `align-text` / `align`.
- [x] `cu2.ts` (405) → `cu2-state` / `cu2-lines` / `cu2`.
- [x] `practice.ts` (397) → `practice-generate` / `practice-text` / `practice-eval`.
- [x] `settings.ts` (337), `continuous.ts` (310), `extract.ts` (301): partir solo si siguen >300 al llegar aquí.
- [x] Un split por commit; tests verdes sin reescritura tras cada uno.

## Fase 7 — Verificación final y docs

- [x] `npm run check` (con tsc) + `npm test` + smoke manual completo (sesión, práctica, guardar, historial, settings, TTS).
- [x] Recuento `wc -l`: ningún `src/**/*.ts` >300 líneas; lista final en spec.md.
- [x] Actualizar `spec/constitution/roadmap.md` (117 → "Hecho ✅") y `tech-stack.md`/`README.md` si aplica.
- [x] Marcar estado `done` y criterios en `spec.md`.
