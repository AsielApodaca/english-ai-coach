# 001-ejemplo · Pintado incremental de la evaluación de fragmentos

**Estado:** implementado ✅

> Feature de referencia tomada del git log: `116-fast-fragment-eval` (PR #29, `refactor/eval-fragmentos-incremental`). Este directorio existe como plantilla de ejemplo; la especificación operativa vive en `../116-fast-fragment-eval/spec.md`.

## Qué hace

Al terminar de repetir un fragmento, el semáforo de palabras (green/amber/red) y el chip de score aparecen en cuanto terminan whisper + la alineación determinista, sin esperar la respuesta del LLM. La evaluación del LLM corre en background y su refinación —issues, tips, verdict, `coachLine` y el recoloreo forced-amber— llega después mediante `GET /api/attempt/:id/feedback`. En el camino de fallo, la locución del coach espera la refinación (con tope de 10 s) justo antes de hablar, solapada con la repetición en audio del usuario.

## Por qué

- **Latencia percibida:** el usuario ve el semáforo en ~tiempo de whisper en lugar de los 4–8 s que tomaba la cadena serial whisper + LLM + persistencia.
- **Sin perder calidad:** el LLM sigue aportando tips, verdict, `coachLine` y el recoloreo amber; solo se difiere.
- **Score/passed intactos:** al ser deterministas (`align.score`), el flujo pass/fail (avance/reintento) no cambia de semántica.

## Criterios de aceptación

- [x] `evaluateFragment` queda descompuesta en evaluación determinista + refino LLM, manteniéndose `evaluateFragment` como composición para `POST /api/evaluate` y sus tests.
- [x] `POST /api/attempt` responde tras whisper + align con la evaluación determinista y un `attemptId`; el refino se lanza en background antes de responder.
- [x] Registro de refinación en memoria con TTL (~60 s), techo de entradas y `attemptId = randomUUID()`.
- [x] `GET /api/attempt/:id/feedback` hace long-poll: resuelve `{ refined: true, ... }`, falla/timeout de servidor (~20 s) → `{ refined: false }`, id desconocido → 404.
- [x] La persistencia del intento ocurre antes de responder; en intentos `full` el refino parchea `question.eval` y recalcula el perfil.
- [x] El frontend pinta el semáforo al instante y aplica el recoloreo guarded por `attemptId` + `flowToken`.
- [x] En fallo, se espera el `coachLine` refinado (tope 10 s) antes de hablar; éxito/avance no esperan nada.
- [x] `npm test` y `npm run check` en verde (los tests existentes de `evaluateFragment` siguen pasando).
- [ ] Prueba manual: semáforo visible sin esperar al LLM, con amber y `coachLine` de calidad al llegar.
- [ ] Prueba manual sin ningún proveedor LLM: flujo completo con feedback determinista y sin cuelgues.

## Fuera de alcance

- Whisper `spawnSync` → async (`src/lib/whisper.ts`): sigue siendo el techo de latencia.
- Optimizar la cadena de providers / `available()` / `LLM_TIMEOUT_MS`.
- Mover `persistAttempt` / `loadAllSessions` fuera del camino crítico.
- Cambiar el chip visual, `buildFeedbackText` o la mecánica push-to-talk.
- SSE/streaming (se eligió long-poll por simplicidad con frontend vanilla sin dependencias).
