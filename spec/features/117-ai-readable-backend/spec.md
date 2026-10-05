# 117 · Backend legible para IA (refactor de convenciones)

**Estado:** done ✅ (implementado en la rama `refactor/117-ai-readable-backend`, 18 commits; ver *Verificación final* al final del documento)

## Contexto

- Motivo: `AGENTS.md` incorporó reglas para diseñar el código pensando en un **AI engineer** y en el **desarrollo hecho por IAs**: módulos pequeños (<~300 líneas, una responsabilidad por archivo), contratos explícitos al inicio de cada archivo, comportamiento determinista, tests como especificación ejecutable, sin código "clever" ni efectos ocultos, JSDoc en inglés en funciones no triviales (secciones **Convenciones** y **No hagas** de `AGENTS.md`).
- Este spec es **autocontenido**: una sesión de opencode sin contexto previo debe poder implementar la feature leyendo este directorio + `AGENTS.md` + los archivos referenciados.
- Alcance: **solo backend `src/`** (frontend `public/` fuera de alcance); entrega en **un PR** con las fases como commits internos; rama/commits en inglés.
- Hallazgos verificados el 2026-10-03 contra `main` (`npx tsc --noEmit` ejecutado; rutas y líneas leídas de la fuente). Si el código cambió, re-verificar líneas antes de implementar.

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
- Funciones de dominio embebidas: `persistAttempt` (:209-279), `patchFullEval` (:677-698), `ttsStatus` (:914-940), `avgSessionScore` (:1189), `clampNumber` (:955).
- Sin test de comportamiento: los únicos tests que lo tocan leen su fuente como texto (`cu2.test.ts`, `refinement.test.ts`).

**4. `src/lib/providers/` sin tests directos.** `gemini.ts` (52), `cloudflare.ts` (77), `ollama.ts` (106), `mock.ts` (72), `types.ts` (41) — 348 líneas; los tests usan fakes propios, la lógica real HTTP/parsing/errores queda sin verificar.

**5. Magic numbers (~25-30 sin nombre, con duplicación entre archivos).**

- `practice.ts:327,336` — `score >= 70` / `>= 50` **duplica** `DEFAULT_PASS_THRESHOLD = 70` (`cu2.ts:399`); el umbral real es configurable por sesión (`passThreshold`) pero la evaluación mergeada usa 70 hardcodeado → divergencia silenciosa.
- `practice.ts:324` — pesos `0.75/0.25` de blending sin nombre.
- `learner.ts:74-75` — umbrales `avg >= 80` / `avg < 50` de subida/bajada de nivel.
- Timeouts/buffers duplicados en 4-5 archivos: `timeout: 60_000` (`whisper.ts:103,276`, `piper.ts:477`, `edge-tts.ts:136`), `maxBuffer: 10*1024*1024` (`whisper.ts:103,276`, `edge-tts.ts:137`), `slice(0,500)` stderr (`whisper.ts:105,278`, `edge-tts.ts:142`, `piper.ts:482`), `slice(0,200)` reply (`providers/index.ts:195`, `ollama.ts:98`), `temperature ?? 0.4` + `maxTokens ?? 2048` (`cloudflare.ts:61-62`, `gemini.ts:32`, `ollama.ts:91-92`).
- `extract.ts:208,236,243` — `words.length < 10`, `100_000` chars, `temperature: 0.2, maxTokens: 4096`.
- `lookup.ts:261` — `space > max * 0.6`; `whisper.ts:125,137,144` — `×1000` (s→ms) sin constante.
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
- `src/lib/` ya tiene el **patrón correcto de handler puro** para imitar: `handleXxxRequest(body, deps) → { status, json }` con JSDoc de contrato (`session/session-start.ts`, `ingest/extract.ts` (`handleExtractRequest`), `practice/continuous.ts` (`handleNextQuestionRequest`), `practice/refinement.ts`).

## Qué hace

Refactor del backend en **7 fases internas** (cada fase es un commit en la misma rama/PR), sin cambiar el comportamiento observable de la app más allá de lo indicado explícitamente (errores ahora `{ error }` con status correcto, validación de entradas inválidas, y un test que falle si `npm run check` se degrada). Al final: gate de tipos en verde, contratos documentados y validados, `server.ts` descompuesto y testeable, providers con tests, constantes con nombre y todos los módulos `src/` <300 líneas.

## Por qué

- **Legibilidad para IAs:** un agente que abra el repo sin contexto debe poder razonar sobre cualquier módulo aislado: límite de tamaño, contrato en la cabecera, sin estado oculto.
- **Seguridad/robustez:** `session/save` permite hoy sobrescribir sesiones y romper el contrato de error; `chat` acepta bodies ilimitados.
- **Regresión detectable:** sin `tsc` en el gate, los 9 errores actuales demuestran que los errores de tipo se acumulan silenciosamente; los tests de `server.ts`/providers son la especificación ejecutable que faltaba antes de tocar esos archivos.
- **Divergencia de umbral:** el `70` hardcodeado en `practice.ts` puede discrepar de `passThreshold` por sesión → decisiones pass/fail inconsistentes.

## Criterios de aceptación

- [x] `npx tsc --noEmit` → 0 errores; `npm test` → todos en verde (591 pass / 0 fail / 2 skipped); `npm run check` incluye `tsc --noEmit`.
- [x] `grep -rn ": any\|as any\|@ts-ignore" src/ tests/` → 0 coincidencias (sin `any` para tapar los 9 errores).
- [x] Ningún archivo `src/**/*.ts` con >300 líneas (`wc -l` ordenado descendente) — lista en *Verificación final*.
- [x] Las 28 rutas `/api/*` tienen JSDoc con shape de entrada/salida/errores (10 nuevas, 18 ya existentes intactas).
- [x] Middleware de errores: body JSON malformado, excepción no capturada y ruta `/api/*` desconocida responden JSON `{ error }` con status (nunca HTML) — verificado en el smoke de *Verificación final*.
- [x] `POST /api/session/save` con `{"id":"otra-sesión"}` no sobrescribe la sesión existente (id ignorado server-side); `saveSession` roto → 500 `{ error }`.
- [x] `POST /api/session/checkpoint` rechaza `eval`/`words` con shape inválido (400 `{ error }`); `POST /api/chat` con message > `CHAT_MAX_CHARS` → 400.
- [x] Tests de los 5 providers pasan (`available`, `complete`, `ProviderError`, `extractJSON` tolerante); tests HTTP de comportamiento sobre `createApp(deps)` sin abrir puerto en import.
- [x] `warmInFlight` ya no es `let` de módulo; importar el módulo de app no llama `app.listen` (test puede importarlo sin puerto).
- [x] `60_000` / `10 * 1024 * 1024` solo aparecen en `subprocess.ts`; el umbral de pass `70` vive en una constante nombrada única (`DEFAULT_PASS_THRESHOLD`, `cu2-lines.ts`); no hay dynamic import sin razón en `whisper.ts` (grep `await import` → 0 en `src/`).
- [x] Sin dependencias npm nuevas (`express`, `mammoth`, `pdf-parse` + sus `@types`/`typescript`); `npm test` y `npm run check` siguen siendo los únicos gates.
- [x] `spec/constitution/roadmap.md` → 117 en "Hecho ✅"; este `spec.md` en estado `done` (mismo PR).

## Fuera de alcance

- Frontend `public/` (`practice-view.js` 1943 líneas, `config-view.js`, `ipa.js`, tests de UI) — feature futura.
- Whisper `spawnSync` → async (techo de latencia; mencionado en 116 como trabajo aparte).
- Cambios de comportamiento de evaluación, flujo CU2, TTS/STT.
- Nuevas dependencias npm (incluido supertest/jest).
- Optimizar la cadena de providers/`available()`/`LLM_TIMEOUT_MS` (fuera de alcance en 116, sigue fuera).
- Renumeración o fusión de features existentes en `spec/`.

## Recursos

- `AGENTS.md` (Convenciones, No hagas, Flujo de trabajo, Documentación).
- `spec/constitution/tech-stack.md` (comandos, módulos clave), `spec/constitution/roadmap.md`.
- Patrones a imitar: `src/lib/session/session-start.ts` (handler puro + `SessionStartDeps` + `{status, json}`), `src/lib/ingest/extract.ts` (`handleExtractRequest`), `src/lib/practice/continuous.ts` (`handleNextQuestionRequest`), `src/lib/lookup/lookup-types.ts` (constantes nombradas).
- Tests rojos de referencia: `tests/coach.test.ts`, `tests/karaoke.test.ts`, `tests/storage.test.ts`.
- Features relacionadas: `116-fast-fragment-eval` (split de `practice.ts`), `102-session-model-v2` (tipos de sesión), `112-word-popover-dictionary` (contrato `ok:false` de lookup).
- Plan detallado: `plan.md`; checklist de ejecución: `tasks.md`.

## Verificación final (2026-10-03, rama `refactor/117-ai-readable-backend`)

**Gates** (ejecutados tras cada commit de la rama):

```
npx tsc --noEmit         → 0 errores
npm test                 → 593 tests · 591 pass · 0 fail · 2 skipped
npm run check            → verde (tsc --noEmit + node --check de la lista explícita)
grep ": any|as any|@ts-ignore" src/ tests/ → 0 coincidencias
```

**Ronda de review posterior a la implementación (findings corregidos en el commit final de la rama):**

- Código muerto del split (`lookup-types.ts` duplicaba tres constantes) e import sin usar (`session-guards.ts`).
- Cifras de este documento y del `tech-stack.md` desalineadas con la realidad.
- Los 5 ficheros JS de `public/` que no estaban en el script `check` (`app.js`, `ui/dom.js`, `ui/router.js`, `ui/store.js`, `speech/recorder-wave.js`), con test que falla si la lista vuelve a quedarse corta (`tests/type-gate.test.ts`).
- Tests que faltaban para criterios ya tildados: `saveSession` roto → 500 `{error}`, `evaluate`/`attempt` con ids inválidos → 400, y cableado de `readPassThreshold` en `POST /api/evaluate`.

**Smoke manual** (`node src/server.ts`, solo GET, sin escribir `data/`):

| Request | Resultado |
| --- | --- |
| `GET /api/health` | 200 `{ok:true, providers, whisper, tts, dataDir}` |
| `GET /api/profile` | 200 |
| `GET /api/history` | 200 |
| `GET /api/does-not-exist` | 404 `{error:"Unknown API route: …"}` (JSON, no HTML) |
| `POST /api/chat` body malformado | 500 `{error:"Expected property name…"}` (JSON, no HTML; ver *Elección deliberada* en `http-errors.ts`) |

**Recuento `wc -l` de `src/**/*.ts` (descendente, 67 archivos, 8802 líneas) — ninguno >300:**

```
   300 src/lib/refinement.ts
   299 src/lib/storage-session.ts
   297 src/lib/whisper.ts
   294 src/lib/align-words.ts
   272 src/lib/tts-cache.ts
   271 src/lib/wav.ts
   267 src/lib/session-types.ts
   265 src/lib/lookup-providers.ts
   262 src/lib/routes/session.ts
   259 src/lib/extract-parse.ts
   248 src/lib/settings.ts
   246 src/lib/routes/audio.ts
   244 src/lib/routes/attempt.ts
   233 src/lib/lookup-resolve.ts
   215 src/lib/cu2-state.ts
   208 src/lib/providers/index.ts
   203 src/lib/practice-eval.ts
   184 src/lib/piper-voices.ts
   184 src/lib/learner.ts
   165 src/lib/session-start.ts
   156 src/lib/edge-tts.ts
   154 src/lib/piper.ts
   145 src/lib/cu2-transitions.ts
   137 src/lib/routes/practice.ts
   137 src/lib/continuous-handler.ts
   131 src/lib/lookup-validate.ts
   129 src/lib/session-guards.ts
   124 src/lib/practice-text.ts
   121 src/lib/settings-types.ts
   120 src/lib/routes/health.ts
   117 src/lib/practice-generate.ts
   117 src/lib/align-text.ts
   116 src/lib/attempt-persist.ts
   112 src/lib/routes/sessions.ts
   112 src/lib/routes/profile.ts
   111 src/lib/storage.ts
   101 src/lib/lookup-types.ts
   106 src/lib/tts-status.ts
   106 src/lib/providers/ollama.ts
    97 src/lib/app.ts
    91 src/lib/continuous-generate.ts
    89 src/lib/continuous-adaptive.ts
    82 src/lib/routes/lookup.ts
    79 src/lib/providers/types.ts
    77 src/lib/providers/cloudflare.ts
    75 src/server.ts
    72 src/lib/providers/mock.ts
    71 src/lib/storage-context.ts
    71 src/lib/routes/chat.ts
    70 src/lib/extract-handler.ts
    66 src/lib/align.ts
    54 src/lib/cu2-lines.ts
    52 src/lib/session-payload.ts
    52 src/lib/routes/chain.ts
    52 src/lib/providers/gemini.ts
    52 src/lib/http-errors.ts
    50 src/lib/practice.ts
    44 src/lib/prosody.ts
    37 src/lib/routes/files.ts
    36 src/lib/storage-profile.ts
    34 src/lib/lookup.ts
    33 src/lib/subprocess.ts
    30 src/lib/cu2.ts
    21 src/lib/continuous.ts
    19 src/lib/json-file.ts
    14 src/lib/time.ts
    14 src/lib/extract.ts
```

Antes del refactor: `server.ts` 1199 · `lookup.ts` 698 · `storage.ts` 653 · `piper.ts` 542 · `align.ts` 438 · `cu2.ts` 405 · `practice.ts` 397 · `settings.ts` 337 · `continuous.ts` 310 · `extract.ts` 301 — hoy ninguno supera 300.

**Desviaciones del plan registradas durante la implementación:**

- Fase 6: los splits requirieron módulos de apoyo que el plan no enumeraba (`json-file.ts` para el ciclo de escritura atómica de `storage`, `session-guards.ts`/`storage-context.ts` para evitar ciclos, `continuous-generate.ts` porque dejar la generación en `continuous.ts` habría hecho que el handler importara el barrel → ciclo en runtime). Los nombres siguen los ya existentes (`practice-generate.ts`, `piper-voices.ts`).
- Fase 6: `whisper.ts` (305) y `refinement.ts` (303) no estaban en el checklist (no superaban 300 cuando se escribió el plan; Fase 5 los empujó). Al ser responsabilidades únicas y cohesivas se compactó su JSDoc en lugar de partirlos.
- Fase 1: el body JSON malformado responde 500 `{error}` (no 400): decisión deliberada y documentada en `src/lib/http-errors.ts`, cubierta por `tests/http-errors.test.ts`.
