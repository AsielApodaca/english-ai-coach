# 117 · Backend legible para IA (refactor de convenciones) — Plan

## Enfoque

Siete fases internas, cada una un commit en la misma rama (`docs/…` → PR único a `main`), en este orden: **0 gate de tipos → 1 contratos HTTP → 2 validación → 3 partir `server.ts` → 4 tests → 5 constantes → 6 split de módulos → 7 verificación final**. Seguridad primero (fases 1-2 cierran huecos reales), y los tests de la fase 4 son la red que habilita los splits de la fase 6. Regla transversal por fase: `npm test` + `npm run check` en verde al cerrar cada commit; si un split rompe imports, se usa re-export (`export * from`) en el archivo original en lugar de reescribir todos los consumidores.

## Implementación

### Fase 0 — Gate de tipos

1. `package.json` — `npm run check` pasa a ejecutar `npx tsc --noEmit` (el tsconfig ya cubre `src/**/*.ts` + `tests/**/*.ts`) además del `node --check` de `public/*.js` (JS puro, `checkJs: false`, fuera del tsconfig). Decisión: mantener ambos chequeos; orden `tsc` primero.
2. Corregir los 9 errores **sin `any` y sin `@ts-ignore`**: `align.ts:399,406` → `new Array<boolean>(n).fill(false)` (hoy declara `number[]`); los 7 de tests → tipar helpers/dobles (`extract-files.test.ts` casting del body de respuesta, `recorder-wave.test.ts` parámetro `wav`, `settings.test.ts` fixture `AdaptiveSettings` con `enabled`, `stt.test.ts` aceptar `undefined` en lugar de `null`, `karaoke-color.test.ts` shape del mock).
3. Añadir test que fije el gate: aserción sobre el script `check` de `package.json` que falle si alguien quita el `tsc` (protege contra regresión del propio proceso).

### Fase 1 — Contratos HTTP explícitos

1. `src/server.ts` (o `src/lib/http-errors.ts`) — middleware `errorHandler` registrado para `/api`: traduce cualquier excepción no capturada (incluye body JSON malformado, que Express lanza al parsear) en `res.status(500).json({ error: string })`; + `notFound` para `/api/*` → 404 `{ error }`. Documentar en su JSDoc la regla de forma: "`{ error }` es la base; campos adicionales (`code`, `hint`, `ok`) solo si su spec los define".
2. JSDoc de contrato (inglés, con shape de entrada/salida y casos de error) en las 10 rutas sin contrato: `health`, `practice/new`, `evaluate`, `session/save`, `next-step`, `history`, `profile`, `transcribe`, `whisper/status`, `chat`. Formato: el de `POST /api/session/start` / `POST /api/session/next-question`.
3. Uniformizar sin romper contratos documentados: se conservan `ok:false` de `/api/lookup` (spec 112), `code` de whisper/tts (specs 002/007) y `hint` de `tts-unavailable` (spec 007). Si algún shape cambia de verdad, actualizar su `spec/` en el mismo PR (regla de AGENTS.md).

### Fase 2 — Validación de entrada

1. `POST /api/session/save` — ignorar el `id` del cliente y generar siempre `randomUUID()` server-side (verificar antes cómo lo llama `public/`; si el frontend depende del id ecoado, devolver el generado — el contrato de respuesta `{ id, nextStep }` no cambia). Validar `question`/`fullAnswer` con tipos; mover `storage.saveSession` **dentro de `try`** (hoy :326, fuera → HTML 500).
2. `POST /api/session/checkpoint` — `isSessionEval(v): v is SessionEval` en `storage.ts` junto al tipo; validar `fullAttempt.words` como array de `{ text, startMs, endMs }`; `saveSession` dentro de `try`.
3. `POST /api/chat` — constante `CHAT_MAX_CHARS` (4000) → 400 `{ error }`.
4. `POST /api/transcribe` — validar cabecera RIFF/WAV del buffer antes de escribir a disco y spawnear `whisper-cli` → 400 si no.
5. `isProviderId(v): v is ProviderId` en `providers/types.ts`; usarlo en `candidates()`/`lookupCandidates()` sustituyendo el cast `as ProviderId` (:102) — desconocido cae al default documentado.
6. `POST /api/attempt` / `/api/evaluate` — `sessionId`/`fragmentId`: validar formato (`/^[a-zA-Z0-9-]+$/`, mismo criterio que `storage.ts:301-304`) antes de pasarlo a `persistAttempt`.

### Fase 3 — Partir `server.ts` y hacerlo testeable

1. `src/lib/app.ts` (o `src/server-app.ts`) — `createApp(deps: AppDeps): Express` donde `AppDeps = { storage, providers, primaryProviderId, ttsCache, refinements, lookupCache, rootDir, env }` (tipo explícito al inicio del archivo). `src/server.ts` queda como entrypoint: env → `createApp` → `listen`.
2. Eliminar `let warmInFlight` (:65) → closure dentro de `createApp`.
3. Mover funciones de dominio a `src/lib/`: `persistAttempt` → **nuevo** `src/lib/attempt-persist.ts` (con test); `patchFullEval` → `refinement.ts` (ya parcha evals); `ttsStatus`/`clampNumber`/`queryList` → **nuevo** `src/lib/tts-status.ts`; `avgSessionScore` → `storage.ts` (junto a `sessionScore`).
4. Reagrupar rutas en `src/lib/routes/`, cada archivo exporta `registerXxxRoutes(app, deps)` con JSDoc de contrato: `health.ts` (health, warmup), `practice.ts` (practice/new, evaluate, next-step, attempt, attempt/:id/feedback), `session.ts` (save, checkpoint, start, :id, next-question, sessions CRUD, export, history), `profile.ts` (profile, profile/settings, storage, export), `audio.ts` (transcribe, whisper/status, tts, tts/status), `chat.ts`, `lookup.ts`, `files.ts` (files/extract).
5. Fase de **movimiento puro**: cero cambio de comportamiento; `npm test` + smoke manual (`npm start` → health, sesión completa) antes de continuar.

### Fase 4 — Tests de especificación

1. Tests de providers (`tests/providers-*.test.ts`): `available()` con env fake (con/sin credenciales), `complete()` happy path con `fetch` fake, no-2xx → `ProviderError` con `canRetry` correcto, reply no-JSON → `extractJSON` tolera code fences/ruido, abort/timeout → `ProviderError`. `mock.ts` puro → respuestas directas.
2. Tests HTTP de comportamiento sobre `createApp(depsFakes)`: arrancar en puerto efímero (`app.listen(0)`) y usar `fetch` — **sin dependencias nuevas**. Cobertura mínima: `GET /api/health` 200; `session/save` con id de cliente → no sobrescribe; body malformado → JSON `{ error }` (nunca HTML); `/api/desconocida` → 404 `{ error }`; `chat` con message > `CHAT_MAX_CHARS` → 400; `checkpoint` con eval inválido → 400.
3. `tests/coach.test.ts` — aislar la mutación de `process.env.LLM_TIMEOUT_MS` en try/finally (o helper) para que un fallo no contamine el resto.
4. Mover `persistAttempt` lleva sus asserts (extraer lo que hoy solo se cubre indirectamente).

### Fase 5 — Constantes nombradas

1. **Nuevo `src/lib/subprocess.ts`**: `SUBPROCESS_TIMEOUT_MS = 60_000`, `SUBPROCESS_MAX_BUFFER = 10 * 1024 * 1024`, `STDERR_SNIP_LEN = 500` y `snip()` compartido → consumir desde `whisper.ts:103,105,276,278`, `piper.ts:477,482`, `edge-tts.ts:136,137,142`.
2. `providers/types.ts`: `LLM_DEFAULT_TEMPERATURE = 0.4`, `LLM_DEFAULT_MAX_TOKENS = 2048` → `cloudflare.ts:61-62`, `gemini.ts:32`, `ollama.ts:91-92`. `providers/index.ts:195` + `ollama.ts:98`: `REPLY_SNIP_LEN = 200`.
3. `whisper.ts:125,137,144` → `MS_PER_S = 1000`.
4. `learner.ts:74-75` → `LEVEL_UP_AVG = 80`, `LEVEL_DOWN_AVG = 50`.
5. `extract.ts` → `MIN_LANG_WORDS = 10`, `DOC_CHAR_BUDGET = 100_000`, `EXTRACT_LLM_TEMPERATURE = 0.2`, `EXTRACT_LLM_MAX_TOKENS = 4096`.
6. `practice.ts:327,336` — eliminar el `70`/`50` hardcodeado: unificar con `DEFAULT_PASS_THRESHOLD` (hoy en `cu2.ts:399`; moverlo a `practice.ts` si no crea ciclo — verificar dirección de import `cu2 → practice`) y pasar `passThreshold` de la sesión cuando exista. Pesos `0.75/0.25` → `LEXICAL_WEIGHT` / `NATURALNESS_WEIGHT`.
7. `whisper.ts:79` — pasar `renameSync` al import estático del archivo (fin del dynamic import innecesario).
8. Tests: los que hardcodeen estos valores pasan a importar la constante (son la red de regresión).

### Fase 6 — Partir módulos >300 líneas

Reglas por split: (a) re-export en el original (`export * from`) o actualizar imports — preferir actualizar cuando <20 sitios; (b) interfaces/contratos al inicio del archivo nuevo; (c) tests existentes en verde **sin reescritura**; (d) cada archivo <300 líneas, una responsabilidad. Un split por commit.

1. `lookup.ts` (698) → `lookup-types.ts` (interfaces + constantes, ≈:1-130) · `lookup-validate.ts` (normalize/validate/count/same-origin, ≈:145-267) · `lookup-providers.ts` (dictionary/translation/llm + cache, ≈:284-526) · `lookup-resolve.ts` (`resolveLookup` + deps, ≈:533-698); original re-exporta.
2. `storage.ts` (653) → `session-types.ts` (tipos v1+v2 + constantes, ≈:9-260) · `storage-session.ts` (lectura/escritura/grupos/resumen) · `storage-profile.ts` (profile + settings persistence); `storage.ts` queda con `createStorage` + re-exports. **Es el archivo de tipos más importado del repo: exports idénticos.**
3. `piper.ts` (542) → `piper-voices.ts` (descarga/listado) + `piper.ts` (síntesis subprocess). Red: `piper.test.ts`, `audio-normalize.test.ts`.
4. `align.ts` (438) → `align-words.ts` (`alignWords` LCS + semáforo) · `align-text.ts` (`alignTextWords` fallback) · `align.ts` (tipos + recomposición).
5. `cu2.ts` (405) → `cu2-state.ts` (máquina de estados pura) · `cu2-lines.ts` (líneas habladas/builders) · `cu2.ts` (re-export). Red: `cu2.test.ts` (769 líneas) — es la spec ejecutable de CU2.
6. `practice.ts` (397) → `practice-generate.ts` (generatePracticeSet/FirstQuestion + `CATEGORY_STAGES`) · `practice-text.ts` (normalize/tokenize/wordMatch/fillers) · `practice-eval.ts` (deterministic + merge + refine) · `practice.ts` re-exporta (coherente con el split de 116).
7. `settings.ts` (337) → `settings-types.ts` (types/defaults) si el merge/parse sigue >300 tras la Fase 5.
8. Frontera: `continuous.ts` (310) → `continuous-adaptive.ts` (`computeAdaptive` + clamps) + `continuous-handler.ts`; `extract.ts` (301) → `extract-parse.ts` + `extract-handler.ts`. Partir solo si siguen >300 al llegar aquí.
9. `server.ts` <300 ya garantizado por Fase 3.

### Fase 7 — Verificación final y docs

1. `npm run check` (con `tsc`), `npm test`, `npm start` + smoke manual: crear sesión, practicar, guardar, historial, settings, TTS.
2. Recuento `wc -l` de `src/**/*.ts` — ningún archivo >300; pegar la lista final en este spec (estado `done`).
3. Actualizar `spec/constitution/roadmap.md` (117 → "Hecho ✅"), `spec/constitution/tech-stack.md` si cambió comandos/módulos clave, `README.md` si aplica.

## Decisiones

- **Orden fases: seguridad antes que refactor (0→1→2→3…)** — los huecos de `session/save`/`chat` se cierran pronto y en commits pequeños; alternativa descartada: partir primero `server.ts` (mezclaría movimiento puro con cambio de comportamiento en el mismo diff y dificultaría el bisect).
- **`createApp(deps)` en lugar de mockear módulos** — inyección explícita es el patrón ya usado por los handlers puros (`SessionStartDeps`); mockear imports obligaría a metaprogramming, prohibido por AGENTS.md.
- **`routes/` como carpeta con `registerXxxRoutes(app, deps)`** — mantiene Express idiomatic sin envolver el framework; alternativa descartada: router de Express por archivo con deps por closure (equivalente, se elige la forma más literal).
- **`session/save` ignora el `id` en vez de rechazarlo** — el frontend actual lo envía; rechazar rompería el flujo de guardado sin aportar seguridad (el id generado server-side es el que se persiste).
- **Re-export (`export * from`) como red de imports** — evita reescribir decenas de consumidores en el mismo PR; se prefiere actualizar imports cuando el sitio es <20 para no acumular indirection.
- **Tests HTTP con `app.listen(0)` + `fetch` a mano** — cero dependencias nuevas (regla dura del proyecto); supertest queda descartado.
- **Constantes junto a su dominio** (`subprocess.ts`, `providers/types.ts`), no en un `constants.ts` global — evita un grab-bag que vuelve a crecer sin control.
- **Umbrales de `practice` unificados con `DEFAULT_PASS_THRESHOLD`** — única fuente para pass/fail; se verifica el sentido del import `cu2 ↔ practice` para no crear ciclo.

## Riesgos

- **Split masivo rompe imports** — regla por fase: re-export o actualización de imports + tests verdes; un split por commit; rollback por commit.
- **`storage.ts` es central** — sus tests (`storage.test.ts` + indirectos en 6 archivos) son la red; commit propio, nada más se toca a la vez.
- **Fase 3 (movimiento puro) se contamina con la Fase 2 (comportamiento)** — commits separados; si el diff de la fase 3 crece, parar y dejar la validación pendiente como follow-up en vez de mezclar.
- **Compatibilidad frontend con `session/save` sin `id`** — verificar las llamadas en `public/` antes de decidir (R2 fase 2); el shape de respuesta `{ id, nextStep }` se conserva.
- **`tsc` nuevo en el gate puede fallar en CI/local por errores preexistentes** — la fase 0 los corrige primero en el mismo commit que habilita el gate (un solo commit rojo).
- **`passThreshold` puede no llegar a `/api/evaluate`** — investigar el cableado antes de unificar; si no hay sesión en esa ruta, la constante es el fallback documentado.
