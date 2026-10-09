# 116 · Pintado incremental de la evaluación de fragmentos

**Estado:** done ✅ (implementado, review aprobado; checklist manual pre-merge pendiente de verificación en browser)

## Contexto

- Caso de uso: CU2, paso 11 (usuario repite el fragmento; el sistema evalúa y muestra el semáforo) (`../../use-cases/CU2.md`).
- Pantallas: feedback de práctica — semáforo de palabras + chip de score (`../../design/screens.md`).
- Base:
  - `src/server.ts` — `POST /api/attempt` (línea ~676): whisper → `evaluateFragment` (LLM) → align → `persistAttempt` → `res.json`.
  - `src/lib/practice.ts` — `evaluateFragment` (línea ~273): mezcla `wordMatch` determinista + `chatJSON` LLM (`naturalness`), score `0.75·lexical + 0.25·naturalness`.
  - `src/server.ts:643` — `forcedAmberWordsFromIssues`: los colores amber forzados dependen de los `issues` del LLM.
  - `public/ui/practice-view.js` — `captureAttempt` → `submitAudio`/`submitText` → `renderFeedback`/`colorWords` (pintado gating sobre la respuesta HTTP).
- Problema: al terminar de repetir un fragmento tardan **4–8 s** en mostrarse el semáforo, porque `/api/attempt` ejecuta en serie whisper (~0,5–3 s) + LLM (~1,5–6 s) + persistencia antes de responder.
- Hallazgo clave: el `score` y `passed` de la respuesta **ya son deterministas** (`align.score`, `server.ts:760`). Del LLM solo dependen: `forcedAmberWords` (colores), `issues`, `tips`, `verdict` y `coachLine`.

## Qué hace

El semáforo se pinta en cuanto termina whisper + la alineación determinista (sin esperar al LLM). La evaluación del LLM corre en background y su refinación (issues, tips, verdict, coachLine y recoloreo forced-amber) llega después vía un nuevo endpoint `GET /api/attempt/:id/feedback` (long-poll sobre un registro en memoria). El frontend pinta rápido y refina cuando llega; la calidad de la locución de fallo (`coachLine`) se conserva esperando la refinación solo justo antes de hablar (solapada con la repetición en audio del usuario).

## Por qué

- **Latencia percibida:** el usuario ve el semáforo en ~tiempo de whisper en lugar de 4–8 s.
- **Sin perder calidad:** el LLM sigue aportando tips/coachLine y el recoloreo amber; solo se difiere.
- **Score/passed intactos:** al ser deterministas, el flujo pass/fail (avance/reintento) no cambia de semántica.

## Requerimientos funcionales

- [x] **Split de evaluación** (`src/lib/practice.ts`): `evaluateFragment` se descompone en una evaluación determinista (lexical + issues derivados, sin LLM) y un refino LLM (`refineWithLLM` o equivalente). `evaluateFragment` se mantiene como composición (determinista + refino await) para `POST /api/evaluate` (`server.ts:182`) y sus tests.
- [x] **Respuesta rápida** (`POST /api/attempt`): tras whisper + align (sin forcedAmber), responde de inmediato con la evaluación determinista y un `attemptId`. El `score`/`passed` de la respuesta no cambian de valor. El refino LLM se lanza en background antes de responder.
- [x] **Registro de refinación:** `Map<attemptId, Promise<Refinement>>` en memoria con TTL (purga al acceder, ~60 s) y techo de entradas. `attemptId = randomUUID()`.
- [x] **Endpoint de refino:** `GET /api/attempt/:id/feedback` hace long-poll sobre la promesa. Resuelve → `{ refined: true, issues, tips, verdict, coachLine, words (re-align con forcedAmber), provider }`. Falla el LLM o timeout de servidor (~20 s, configurable) → `{ refined: false }` (el cliente conserva el estado determinista). Id desconocido → 404 `{ error }`.
- [x] **Persistencia:** se mantiene antes de responder con la evaluación determinista (durabilidad). Si el intento es `full`, cuando llega la refinación se parcha `question.eval` (score/verdict/tips/issues) **y se recalcula el perfil** (`computeStats` lee `q.eval.issues` para `weakErrors`). `next` conserva la decisión align-based. Los fragmentos no almacenan tips → sin patch.
- [x] **Frontend pintado inmediato** (`practice-view.js`): `outcomeFromJson` incorpora `attemptId`; `renderFeedback` se ejecuta igual que hoy en cuanto llega la respuesta (sin cambios visibles en el chip/passed).
- [x] **Frontend refinación:** disparar la fetch de refino sin `await` tras pintar; aplicar el recoloreo (forced-amber) cuando llegue, guardado por `attemptId` + `flowToken` (solo si el intento sigue vigente).
- [x] **Frontend fallo:** esperar la refinación (con tope de tiempo, p. ej. 10 s) justo antes de `speak(outcome.coachLine)`; si expira o `refined:false` → hablar el coachLine determinista. Éxito y flujo de avance: no se espera nada. **[Modificado — chore `practice-ui-cleanup`]:** originalmente el `replayUserWav` del fallo se solapaba con el LLM (el refino aterrizaba durante la reproducción del WAV del usuario); el replay automático fue retirado — el audio del usuario es on-demand vía el chip de feedback — y el solape ya no existe, pero la espera acotada de la refinación antes del hint se mantiene.
- [x] **Modo texto y fallback browser STT:** mismo camino rápido (`submitText` y el fallback `practice-view.js:976` no cambian de contrato, solo reciben `attemptId`).
- [x] **Transcripción en blanco** (`isBlankTranscript`): respuesta inmediata como hoy, sin `attemptId` ni refino.

## Criterios de aceptación

- [x] `tests/coach.test.ts`: los 3 tests existentes de `evaluateFragment` siguen en verde (API compuesta intacta).
- [x] Tests nuevos: evaluación determinista sin LLM (issues derivados, score lexical); merge de refino (naturalness → score combinado, verdict, forcedAmber sobre `alignWords`); registro de refinación (resolve, reject → `refined:false`, id desconocido → 404, TTL).
- [x] `npm test` y `npm run check` en verde.
- [ ] Prueba manual: repetir un fragmento → semáforo visible sin esperar al LLM; los colores amber forzados y el coachLine hablado llegan con calidad LLM (o fallback determinista si no hay proveedor); pass/fail y avance/reintento idénticos a hoy.
- [ ] Prueba manual sin proveedor LLM (todos caídos): flujo completo funciona con feedback determinista, sin cuelgues.

## Fuera de alcance

- Whisper `spawnSync` → async (`src/lib/whisper.ts:276`) — sigue siendo el techo de latencia tras esta feature (criterio `<300 ms` de `111-push-to-talk` queda pendiente de un trabajo aparte).
- Optimizar la cadena de providers/`available()`/`LLM_TIMEOUT_MS` (`src/lib/providers/index.ts`).
- Mover `persistAttempt`/`loadAllSessions` fuera del camino crítico.
- Cambiar el chip visual, `buildFeedbackText` o la mecánica PTT.
- SSE/streaming (se eligió long-poll por simplicidad y encaje con frontend vanilla sin dependencias).

## Recursos

- `src/lib/practice/practice.ts`, `src/server.ts`, `public/ui/practice-view.js`, `tests/coach.test.ts`, `spec/use-cases/CU2.md`.
