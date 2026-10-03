# 117 · Backend legible para IA (refactor de convenciones)

**Estado:** proposed 📝 (especificado, sin implementar)

## Contexto

- Motivo: `AGENTS.md` acaba de incorporar reglas para diseñar el código pensando en un **AI engineer** y en el **desarrollo hecho por IAs**: módulos pequeños (<~300 líneas, una responsabilidad por archivo), contratos explícitos al inicio de cada archivo, comportamiento determinista, tests como especificación ejecutable, sin código "clever" ni efectos ocultos, y documentación JSDoc en inglés en funciones no triviales. Ver secciones **Convenciones** y **No hagas** de `AGENTS.md`.
- Este documento planifica el refactor del **backend `src/`** para que cumpla esas reglas. Es autocontenido: una sesión de opencode sin contexto previo debe poder implementarlo leyendo este spec + `AGENTS.md` + los archivos referenciados.
- Alcance acordado con el usuario: **solo backend `src/`** (frontend `public/` fuera de alcance), **un PR** con fases internas como commits, rama/commits en inglés.
- Hallazgos verificados el 2026-10-03 contra `main` (`npx tsc --noEmit` ejecutado, rutas y líneas leídas de la fuente). Si el código cambió, re-verificar líneas antes de implementar.

### Diagnóstico (evidencia)

**1. El gate de tipos no existe.** `npm run check` solo corre `node --check` (sintaxis); `tsconfig.json` tiene `"strict": true` pero nada ejecuta `tsc`. `npx tsc --noEmit` reporta **9 errores acumulados**:

```
src/lib/align.ts(399,65): error TS2345: Argument of type 'boolean' is not assignable to parameter of type 'number'.
src/lib/align.ts(406,9):  error TS2322: Type 'boolean' is not assignable to type 'number'.
tests/extract-files.test.ts(346-348): error TS18046: 'res.json.file' is of type 'unknown'.  (×3)
tests/karaoke-color.test.ts(50,66):  error TS2353: 'word' does not exist in type '{ status?: string; }'.
tests/recorder-wave.test.ts(6,23):   error TS7006: Parameter 'wav' implicitly has an 'any' type.
tests/settings.test.ts(175,16):      error TS2741: 'enabled' missing in type '{ up: number; down: number; }'.
tests/stt.test.ts(39,24):            error TS2345: null not assignable to '{ whisper?: ... } | undefined'.
```

Los 2 de `align.ts` son **errores en código de producción** (array declarado `number[]`, rellenado con `boolean[]`).

**2. Contratos HTTP débiles en `src/server.ts` (28 rutas, 1199 líneas).**

- **Sin JSDoc de contrato (10/28):** `GET /api/health` (:129), `POST /api/practice/new` (:166), `POST /api/evaluate` (:187), `POST /api/session/save` (:281), `POST /api/next-step` (:338), `GET /api/history` (:511), `GET /api/profile` (:529), `POST /api/transcribe` (:606), `GET /api/whisper/status` (:639), `POST /api/chat` (:1165).
- **Validación débil/ausente (6):**
  - `POST /api/session/save` (:281) — la peor: cero validación, acepta **`id` del cliente** (un cliente puede sobrescribir una sesión existente), construye `SessionV2` desde JSON arbitrario con `String()`/defaults, y **`storage.saveSession(session)` está fuera de `try`** (:326) → un id que no pase `isValidSessionId` o un fichero v1 lanza excepción → manejador por defecto de Express → **HTML en vez de `{ error }`**.
  - `POST /api/session/checkpoint` (:413) — solo valida `id`; `question.eval = evalValue as SessionEval` (:431) persiste cualquier objeto; `fullAttempt.words` (:424) acepta arrays sin validar elementos; `saveSession` fuera de `try`.
  - `POST /api/chat` (:1165) — solo `message` no vacío, **sin límite de longitud** (body hasta 25 MB, :119); `provider` sin validar.
  - `provider` con cast ciego `as ProviderId` en `candidates()` (:102) — afecta a `/api/practice/new`, `/api/evaluate`, `/api/chat`.
  - `POST /api/transcribe` (:606) — no valida formato WAV antes de escribir a disco y lanzar `whisper-cli`.
- **Sin middleware de errores global:** `app.use` solo json+static (:119-120). Cualquier throw no capturado (JSON malformado, `saveSession`) devuelve HTML. Sin 404 para `/api/*`.
- **7 formas inconsistentes de error:** base mayoritaria `{ error: string }` (~44 en server + 16 en lib); excepciones: `{ ok:false, error }` (:1141…), `{ error, code }` (:617, :757), `{ error:"tts-unavailable", hint }` (:1051), 200 con `warning` (:334), 200 con `offline:true` (:1185), 502 con `err.message` crudo (múltiples).

**3. `server.ts` no es testeable ni divisible.**

- Singletons construidos en import time: `storage` (:97), `ttsCache` (:898, con `mkdirSync`+`readdirSync`+`rmSync`), `refinements` (:654), `lookupCache` (:1110), warmup de red (:82-93), `app.listen` (:1195) — **importar `server.ts` abre un puerto** (reconocido en `session-payload.ts:9`).
- Único `let` de módulo: `warmInFlight` (:65) — estado oculto entre handlers.
- Funciones de dominio embebidas en el archivo: `persistAttempt` (:209-279), `patchFullEval` (:677-698), `ttsStatus` (:914-940), `avgSessionScore` (:1189), `clampNumber` (:955).
- Sin test de comportamiento: los únicos tests que lo tocan leen su fuente como texto (`cu2.test.ts`, `refinement.test.ts`).

**4. `src/lib/providers/` sin tests directos.** `gemini.ts` (52), `cloudflare.ts` (77), `ollama.ts` (106), `mock.ts` (72), `types.ts` (41) — 348 líneas; los tests usan fakes propios, la lógica real HTTP/parsing/errores queda sin verificar.

**5. Magic numbers (~25-30 sin nombre, con duplicación entre archivos).**

- `practice.ts:327,336` — `score >= 70` / `>= 50` **duplica** `DEFAULT_PASS_THRESHOLD = 70` (`cu2.ts:399`); el umbral real es configurable por sesión (`passThreshold`) pero la evaluación mergeada usa 70 hardcodeado → divergencia silenciosa.
- `practice.ts:324` — pesos `0.75/0.25` de blending sin nombre.
- `learner.ts:74-75` — umbrales `avg >= 80` / `avg < 50` de subida/bajada de nivel.
- Timeouts/buffers duplicados en 4-5 archivos: `timeout: 60_000` (`whisper.ts:103,276`, `piper.ts:477`, `edge-tts.ts:136`), `maxBuffer: 10*1024*1024` (`whisper.ts:103,276`, `edge-tts.ts:137`), `slice(0,500)` stderr (`whisper.ts:105,278`, `edge-tts.ts:142`, `piper.ts:482`), `slice(0,200)` reply (`providers/index.ts:195`, `ollama.ts:98`), `temperature ?? 0.4` + `maxTokens ?? 2048` (`cloudflare.ts:61-62`, `gemini.ts:32`, `ollama.ts:91-92`).
- `extract.ts:208,236,243` — `words.length < 10`, `100_000` chars, `temperature: 0.2, maxTokens: 4096`.
- `lookup.ts:261` — `space > max * 0.6`.
- `whisper.ts:125,137,144` — `×1000` (s→ms) sin constante.
- **Contrarrejemplos (plantilla a seguir):** `lookup.ts:30-58`, `tts-cache.ts:23-29`, `piper.ts:327-336`, `extract.ts:29-33`, `server.ts:947-952`.

**6. Violaciones puntuales de "sin clever code / efectos ocultos".**

- `whisper.ts:79` — `const { renameSync } = await import("node:fs")` dynamic import innecesario (no hay circularidad ni condición).
- `tests/coach.test.ts:52` muta `process.env.LLM_TIMEOUT_MS` y restaura en `:75` — si el test falla en medio, contamina el resto.

**7. Módulos >300 líneas (backend, 9 + server):** `server.ts` 1199 · `lookup.ts` 698 · `storage.ts` 653 · `piper.ts` 542 · `align.ts` 438 · `cu2.ts` 405 · `practice.ts` 397 · `settings.ts` 337 · `continuous.ts` 310 · `extract.ts` 301.

### Lo que ya cumple (no refactorizar)

- 0 `any` explícito en `src/` y `tests/` (los 2 `as unknown as` de `storage.ts:357,363` son migración v1→v2 justificada).
- 0 efectos en import time en `src/lib/**` (I/O, timers, listeners, `let` de módulo, `console.*`): todo estado vive en closures de factories (`createStorage`, `createTtsCache`, `createRefinementRegistry`, `createLookupCache`).
- 0 metaprogramming (`eval`, `Proxy`, `monkey-patching`, `new Function`).
- 0 tests sin aserción (los 3 que no llaman `assert.` usan el helper `near()` que sí lo hace).
- `src/lib/` ya tiene el **patrón correcto de handler puro** para imitar: `handleXxxRequest(body, deps) → { status, json }` con JSDoc de contrato (`session-start.ts`, `extract.ts` (`handleExtractRequest`), `continuous.ts` (`handleNextQuestionRequest`), `refinement.ts`).

## Qué hace

Refactor del backend en **7 fases internas** (cada fase es un commit en la misma rama/PR), sin cambiar el comportamiento observable de la app más allá de lo indicado explícitamente (errores ahora `{ error }` con status correcto, validación de entradas maliciosas/inválidas, y un test que falle si `npm run check` se rompe). Al final: gate de tipos en verde, contratos documentados y validados, `server.ts` descompuesto y testeable, providers con tests, constantes con nombre y todos los módulos <300 líneas.

## Por qué

- **Legibilidad para IAs:** un agente que abra el repo sin contexto debe poder razonar sobre cualquier módulo aislado: límite de tamaño, contrato en la cabecera, sin estado oculto.
- **Seguridad/robustez:** `session/save` permite hoy sobrescribir sesiones y romper el contrato de error; `chat` acepta bodies ilimitados.
- **Regresión detectable:** sin `tsc` en el gate, los 9 errores actuales demuestran que los errores de tipo se acumulan silenciosamente; los tests de `server.ts`/providers son la especificación ejecutable que faltaba antes de tocar esos archivos.
- **Divergencia de umbral:** `70` hardcodeado en `practice.ts` puede discrepar de `passThreshold` por sesión → decisiones pass/fail inconsistentes.

## Requerimientos funcionales

### Fase 0 — Gate de tipos

- [ ] **R1.0.1** `npm run check` ejecuta `tsc --noEmit` además de `node --check`. Decisión de implementación: reemplazar la lista manual de `node --check` por `npx tsc --noEmit && node --check public/...` o añadir `tsc` como paso primero; `tsconfig.json` ya cubre `src/**/*.ts` + `tests/**/*.ts`. Mantener el chequeo de `public/*.js` (JS puro, `checkJs: false`, fuera del tsconfig).
- [ ] **R1.0.2** Los 9 errores se corrigen (2 en `align.ts` — declarar `new Array<boolean>(n).fill(false)`; los 7 de tests — tipar los helpers/dobles correctamente, **sin usar `any` y sin `@ts-ignore`**).
- [ ] **R1.0.3** `npx tsc --noEmit` en verde y `npm test` en verde tras los cambios.

### Fase 1 — Contratos HTTP explícitos

- [ ] **R1.1.1** Middleware de errores global: `app.use("/api", errorHandler)` que traduzca cualquier excepción no capturada en `res.status(500).json({ error: string })` (nunca HTML), y `app.use("/api", notFound)` → 404 `{ error }` para rutas `/api/*` desconocidas. Debe manejar también body JSON malformado (Express lo lanza al parsear).
- [ ] **R1.1.2** Contrato JSDoc (en inglés, con shape de entrada/salida y casos de error) en las 10 rutas que faltan, siguiendo el formato de `POST /api/session/start` y `POST /api/session/next-question`.
- [ ] **R1.1.3** Forma de error unificada: base `{ error: string }`. Se **preservan** los campos extra ya documentados en sus specs: `ok:false` de `/api/lookup` (spec 112), `code` de `/api/whisper/status`-`/api/tts` (spec 002/007), `hint` de `tts-unavailable` (spec 007). Documentar la regla ("`{ error }` es la base; campos adicionales solo si su spec los define") en el JSDoc del middleware.
- [ ] **R1.1.4** `spec/` actualizado si algún contrato cambia de forma (mismo PR).

### Fase 2 — Validación de entrada

- [ ] **R2.1.1** `POST /api/session/save`: **no aceptar `id` del cliente** — generar id server-side siempre (`randomUUID()`); si se recibe `id`, ignorarlo (compatibilidad con clientes existentes) o rechazar con 400 — decisión: **ignorar silenciosamente y documentarlo en el JSDoc** para no romper al frontend actual que sí lo envía (verificar llamada en `public/`). Validar `question`/`fullAnswer` con tipos; `saveSession` **dentro de `try`** → 500 `{ error }` vía middleware.
- [ ] **R2.1.2** `POST /api/session/checkpoint`: validar shape de `evalValue` (objeto con `score` number, `verdict` string opcional — usar el tipo `SessionEval` como guard, p. ej. función `isSessionEval(v: unknown): v is SessionEval` en `storage.ts` junto al tipo); validar `fullAttempt.words` (array de objetos con `text`/`startMs`/`endMs` number); `saveSession` dentro de `try`.
- [ ] **R2.1.3** `POST /api/chat`: límite de longitud de `message` (constante `CHAT_MAX_CHARS`, proponer 4000) → 400 `{ error }`; validar `provider` con type guard (ver R2.1.5).
- [ ] **R2.1.4** `POST /api/transcribe`: validar que el buffer no esté vacío y (si es accesible sin parser externo) que empieza por cabecera RIFF/WAV antes de escribir a disco; si no, 400 `{ error }`.
- [ ] **R2.1.5** Type guard `isProviderId(v: unknown): v is ProviderId` (en `providers/types.ts`); `candidates()` y `lookupCandidates()` lo usan en lugar del cast `as ProviderId` → provider desconocido cae al default documentado.
- [ ] **R2.1.6** Tests de validación: los casos 400/404/500 responden `{ error }` (Fase 4 los implementa sobre `createApp`).

### Fase 3 — Partir `server.ts` y hacerlo testeable

- [ ] **R3.1.1** Extraer `createApp(deps): Express` y `startServer()`/`app.listen` por separado: `server.ts` (entrypoint) importa `createApp` y hace `listen`; tests importan `createApp` con deps fakes **sin abrir puerto ni crear directorios**.
- [ ] **R3.1.2** Inyección de deps: `AppDeps = { storage, providers, primaryProviderId, ttsCache, refinements, lookupCache, rootDir, env }` (tipo explícito al inicio del archivo). Nada de singletons de módulo con estado en el archivo de rutas.
- [ ] **R3.1.3** Eliminar `let warmInFlight` → estado dentro de `createApp` (closure) o de un objeto `warmup` inyectado.
- [ ] **R3.1.4** Mover funciones de dominio a `src/lib/`: `persistAttempt` → nuevo `src/lib/attempt-persist.ts` (o a `align`/`storage` si encaja — decisión: archivo nuevo `attempt-persist.ts` con su test), `patchFullEval` → `refinement.ts` o `session-payload.ts` (decisión: `refinement.ts`, que ya parcha evals), `ttsStatus`/`clampNumber`/`queryList` → `src/lib/http-tts.ts` o junto a `tts-cache.ts` (decisión: `tts-status.ts`), `avgSessionScore` → `storage.ts` (ya tiene `sessionScore`).
- [ ] **R3.1.5** Reorganizar rutas en módulos por dominio bajo `src/lib/routes/` (decisión: carpeta `routes/`, cada archivo exporta `registerXxxRoutes(app, deps)` con JSDoc de contrato): `health.ts` (health/warmup), `practice.ts` (practice/new, evaluate, next-step, attempt, attempt/:id/feedback), `session.ts` (save, checkpoint, start, :id, next-question, sessions CRUD, export, history), `profile.ts` (profile, settings, storage, export), `audio.ts` (transcribe, whisper/status, tts, tts/status), `chat.ts` (chat), `lookup.ts` (lookup), `files.ts` (files/extract). Alternativa descartada: dejar todo en `server.ts` — viola el límite de 300 líneas y hace imposible el test por ruta.
- [ ] **R3.1.6** `server.ts` queda como entrypoint <300 líneas: env, `createApp`, `listen`, warmup.
- [ ] **R3.1.7** Todo el split es **movimiento de código sin cambio de comportamiento**: `npm test` y prueba manual (`npm start` → health, una sesión completa) en verde antes de pasar a Fase 4.

### Fase 4 — Tests de especificación

- [ ] **R4.1.1** Tests unitarios de providers (`tests/providers-*.test.ts` o un archivo por provider): `available()` con credenciales presentes/ausentes (env fake), `complete()` happy path con `fetch` inyectado/fake devolviendo texto, respuesta no-2xx → `ProviderError` con `canRetry` correcto, JSON malformado del reply → `extractJSON` tolerante (code fences), timeout/abort → `ProviderError`. `mock.ts` es puro → test directo de sus respuestas.
- [ ] **R4.1.2** Tests de comportamiento HTTP sobre `createApp(depsFakes)` con `node:http` (o supertest-like mínimo hecho a mano — **sin dependencias npm nuevas**; decisión: arrancar el app en un puerto efímero con `app.listen(0)` en el test y usar `fetch`): `GET /api/health` → 200; `POST /api/session/save` con `id` de cliente → id ignorado (no sobrescribe); body malformado → 500/400 `{ error }` (nunca HTML); ruta desconocida `/api/*` → 404 `{ error }`; `POST /api/chat` con message > `CHAT_MAX_CHARS` → 400.
- [ ] **R4.1.3** Un test que falle si alguien quita `tsc` del `npm run check` (aserción sobre el script de `package.json`), para que el gate no se degrade.
- [ ] **R4.1.4** `tests/coach.test.ts`: aislar el mutation de `process.env` (try/finally o helper) para que un fallo no contamine otros tests.

### Fase 5 — Constantes nombradas

- [ ] **R5.1.1** Constantes compartidas nuevas (dónde: `src/lib/constants.ts` **no** — preferir junto a su dominio; decisión: cada constante vive en el módulo de su dominio y se importa donde se duplica):
  - `SUBPROCESS_TIMEOUT_MS = 60_000` → `whisper.ts`, `piper.ts`, `edge-tts.ts` (exportar desde un módulo común `src/lib/subprocess.ts` si se quiere un solo origen — decisión: nuevo `src/lib/subprocess.ts` con `SUBPROCESS_TIMEOUT_MS`, `SUBPROCESS_MAX_BUFFER = 10 * 1024 * 1024`, `STDERR_SNIP_LEN = 500` y la función `snip()` compartida).
  - `LLM_DEFAULT_TEMPERATURE = 0.4`, `LLM_DEFAULT_MAX_TOKENS = 2048` → `providers/cloudflare.ts`, `gemini.ts`, `ollama.ts` (exportar desde `providers/types.ts` o `providers/index.ts` — decisión: `providers/types.ts`).
  - `MS_PER_S = 1000` → `whisper.ts:125,137,144`.
  - Umbrales de `learner.ts:74-75` → `LEVEL_UP_AVG = 80`, `LEVEL_DOWN_AVG = 50`.
  - `extract.ts` → `MIN_LANG_WORDS = 10`, `DOC_CHAR_BUDGET = 100_000`, `EXTRACT_LLM_TEMPERATURE = 0.2`, `EXTRACT_LLM_MAX_TOKENS = 4096`.
- [ ] **R5.1.2** `practice.ts:327,336` usa el umbral de pass consistente: exportar `DEFAULT_PASS_THRESHOLD` desde `cu2.ts` (o moverlo a `practice.ts` y que `cu2` lo importe — decisión: mover a `practice.ts` si `cu2` ya importa de `practice`, verificar dirección de import para evitar ciclos) y que `mergeLLMFeedback`/`evaluateFragment` reciban `passThreshold` cuando la sesión lo tenga. **Verificar primero** cómo llega `passThreshold` a `/api/evaluate`; si no hay sesión, usar la constante.
- [ ] **R5.1.3** Pesos de blending `0.75/0.25` → `LEXICAL_WEIGHT`, `NATURALNESS_WEIGHT` en `practice.ts`.
- [ ] **R5.1.4** `whisper.ts:79` — mover `renameSync` al import estático del archivo (fin del dynamic import innecesario).
- [ ] **R5.1.5** Tests: los tests existentes que fijan estos valores siguen en verde (son la red); si alguno hardcodea 70/60_000, actualizar para importar la constante.

### Fase 6 — Partir módulos >300 líneas

Reglas para cada split: (a) el archivo original pasa a ser **re-exportador** (`export * from "./x.ts"`) **o** se actualizan imports — decisión por archivo, preferir actualizar imports cuando sea <20 sitios para no crear indirection innecesaria; (b) contracts/interfaces al inicio del archivo nuevo; (c) tests existentes deben pasar **sin reescritura** (si el test importa `storage.ts` y storage re-exporta, no se toca); (d) cada archivo nuevo <300 líneas y con una responsabilidad.

- [ ] **R6.1.1** `lookup.ts` (698) → `lookup-types.ts` (interfaces + constantes, :1-130), `lookup-validate.ts` (normalize/validate/count/same-origin, :145-267), `lookup-providers.ts` (dictionary/translation/llm + cache, :284-526), `lookup-resolve.ts` (`resolveLookup` + deps, :533-698). Original re-exporta.
- [ ] **R6.1.2** `storage.ts` (653) → `session-types.ts` (tipos v1+v2 + constantes, :9-260), `storage-session.ts` (lectura/escritura/grupos/resumen), `storage-profile.ts` (profile + settings persistence), `storage.ts` queda como `createStorage` + re-exports (<300). **Cuidado:** es el archivo de tipos más importado del repo — mantener exports idénticos.
- [ ] **R6.1.3** `piper.ts` (542) → `piper-voices.ts` (descarga/listado de voces) + `piper.ts` (síntesis subprocess). Verificar tests `piper.test.ts`/`audio-normalize.test.ts`.
- [ ] **R6.1.4** `align.ts` (438) → `align-words.ts` (`alignWords` LCS + semáforo) + `align-text.ts` (`alignTextWords` fallback) + `align.ts` (tipos + re-export/recomposición).
- [ ] **R6.1.5** `cu2.ts` (405) → `cu2-state.ts` (máquina de estados pura) + `cu2-lines.ts` (líneas habladas/builders) + `cu2.ts` (re-export). Es la "spec ejecutable" de CU2 — los tests (`cu2.test.ts`, 769 líneas) son la red.
- [ ] **R6.1.6** `practice.ts` (397) → `practice-generate.ts` (generatePracticeSet/FirstQuestion + CATEGORY_STAGES), `practice-text.ts` (normalize/tokenize/wordMatch/fillers), `practice-eval.ts` (deterministic + merge + refine), `practice.ts` re-exporta. (Coherente con el split de 116.)
- [ ] **R6.1.7** `settings.ts` (337) → separar `settings-types.ts` (types/defaults) de la lógica de merge/parse (~excede poco: priorizar si al extraer `isSessionEval` u otros crece).
- [ ] **R6.1.8** `continuous.ts` (310) y `extract.ts` (301) — partir solo si tras otras fases siguen >300 (son frontera; decisión: partir `continuous.ts` en `continuous-adaptive.ts` (`computeAdaptive` + clamps) y `continuous-handler.ts`; `extract.ts` en `extract-parse.ts` y `extract-handler.ts`).
- [ ] **R6.1.9** `server.ts` <300 tras Fase 3 (criterio ya cubierto por R3.1.6).

### Fase 7 — Verificación final y docs

- [ ] **R7.1.1** `npm run check` (con `tsc`), `npm test`, `npm start` + smoke manual (crear sesión, practicar, guardar, historial) en verde.
- [ ] **R7.1.2** Recuento: ningún `.ts` de `src/` >300 líneas; lista final en la sección "Verificación" abajo.
- [ ] **R7.1.3** Actualizar `spec/constitution/roadmap.md` (feature 117 → "Hecho ✅"), `spec/constitution/tech-stack.md` si cambió la sección de comandos/módulos clave, `README.md` si aplica, y este `spec.md` (estado `done`, criterios marcados).
- [ ] **R7.1.4** AGENTS.md: si la fase 0 introduce un comando nuevo de calidad, dejar `npm run check` como gate único documentado (ya lo es).

## Criterios de aceptación

- [ ] `npx tsc --noEmit` → 0 errores; `npm test` → todos en verde; `npm run check` incluye `tsc`.
- [ ] `grep -rn ": any\|as any\|@ts-ignore" src/ tests/` → 0 coincidencias.
- [ ] Ningún archivo `src/**/*.ts` con >300 líneas (`wc -l | sort -rn`).
- [ ] Las 28 rutas `/api/*` tienen JSDoc con shape de entrada/salida/errores.
- [ ] Test de comportamiento: body malformado y ruta desconocida responden JSON `{ error }` (nunca HTML).
- [ ] `POST /api/session/save` con `{"id":"otra-sesión"}` no sobrescribe la sesión existente.
- [ ] Tests de los 5 providers pasan; `warmInFlight` ya no es `let` de módulo; no hay `app.listen` en import de módulo (test puede importar `createApp` sin puerto).
- [ ] `grep -n "60_000\|10 \* 1024 \* 1024" src/lib/*.ts` solo aparece en `subprocess.ts`; `70` como umbral de pass solo en la constante nombrada.
- [ ] No hay dynamic imports sin razón en `src/lib/whisper.ts`.
- [ ] `npm test` y `npm run check` documentados siguen siendo los únicos gates (sin dependencias npm nuevas).

## Fuera de alcance

- Frontend `public/` (1943-líneas `practice-view.js`, `config-view.js`, `ipa.js`, tests de UI) — feature futura (ej. 118).
- Whisper `spawnSync` → async (latencia; mencionado en 116 como trabajo aparte).
- Cambios de comportamiento de evaluación, flujo CU2, TTS/STT.
- Nuevas dependencias npm (incluido supertest/jest).
- Renumeración o fusión de features existentes en `spec/`.
- Optimización de la cadena de providers/`available()`/`LLM_TIMEOUT_MS` (fuera de alcance en 116, sigue fuera).

## Riesgos y mitigaciones

- **Split masivo rompe imports:** seguir la regla R6 (re-export o actualización de imports + tests verdes por archivo, un split por commit).
- **`storage.ts` es central:** sus tests (259 + indirectos en 6 archivos) son la red; tocarlo en su propio commit.
- **`server.ts` refactor + validación a la vez → difícil de bisecar:** Fase 3 (movimiento puro) y Fase 2 (cambio de comportamiento) en commits separados y ordenados: 3 antes que 2 si se prefiere rebase limpio, o 2 antes si se prioriza cerrar el hueco de seguridad. **Decisión: Fase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7** (seguridad primero, y los tests de Fase 4 benefician a los splits de Fase 6).
- **Compatibilidad del frontend con `session/save` sin `id`:** verificar llamadas en `public/` antes de decidir ignorar vs rechazar (R2.1.1).

## Recursos

- `AGENTS.md` (Convenciones, No hagas, Flujo de trabajo).
- `spec/constitution/tech-stack.md` (comandos, módulos clave), `spec/constitution/roadmap.md`.
- Patrones a imitar: `src/lib/session-start.ts` (handler puro + `SessionStartDeps` + `{status, json}`), `src/lib/extract.ts` (`handleExtractRequest`), `src/lib/continuous.ts` (`handleNextQuestionRequest`), `src/lib/lookup.ts:30-58` (constantes nombradas).
- Tests rojos de referencia: `tests/coach.test.ts`, `tests/cu2.test.ts`, `tests/storage.test.ts`.
- Features relacionadas: `116-fast-fragment-eval` (split de `practice.ts`), `102-session-model-v2` (tipos de sesión), `112-word-popover-dictionary` (contrato `ok:false` de lookup).
