# 001-ejemplo · Pintado incremental de la evaluación de fragmentos — Plan

## Enfoque

Separar la evaluación en dos tiempos: lo determinista (ya era el origen de `score`/`passed`) se responde de inmediato y se persiste; el refino LLM corre en background y se entrega por long-poll. El frontend pinta ya y refina después, sin cambiar el contrato visible del chip de score ni la mecánica de avance/reintento.

## Implementación

1. `src/lib/practice.ts` — descomponer `evaluateFragment` en `evaluateFragmentDeterministic` (lexical + issues derivados, sin LLM), `refineWithLLM` (naturalness, verdict, tips, coachLine) y `mergeLLMFeedback` (combina scores y recolorea con forcedAmber). Mantener `evaluateFragment` como composición para `POST /api/evaluate`.
2. `src/lib/refinement.ts` — registro `Map<attemptId, Promise<Refinement>>` en memoria: purga por TTL (~60 s) al acceder, techo de entradas, `attemptId = randomUUID()`.
3. `src/server.ts` — en `POST /api/attempt`, tras whisper + align sin forcedAmber: persistir, lanzar el refino en background y responder con `attemptId`. Nuevo `GET /api/attempt/:id/feedback` con long-poll (timeout servidor ~20 s → `{ refined: false }`, id desconocido → 404).
4. `src/server.ts` — parchar `question.eval` (score/verdict/tips/issues) y recalcular el perfil (`computeStats` / `weakErrors`) cuando el refino aterriza sobre un intento `full`.
5. `public/ui/practice-view.js` — `outcomeFromJson` incorpora `attemptId`; `renderFeedback` se ejecuta igual de inmediato. Disparar la fetch de refino sin `await` y aplicar el recoloreo guardado por `attemptId` + `flowToken`.
6. `public/ui/practice-view.js` — camino de fallo: solapar `replayUserWav` con el LLM y esperar la refinación (tope 10 s) antes de `speak(outcome.coachLine)`; si expira o `refined: false`, hablar el `coachLine` determinista.

## Decisiones

- **Long-poll en vez de SSE/streaming** — el frontend es vanilla sin dependencias; SSE añadía complejidad de reconexión sin beneficio para un único evento por intento.
- **Registro en memoria, no en disco** — la refinación es efímera (TTL 60 s); persistir ya el intento determinista cubre la durabilidad y evita un store adicional.
- **`score`/`passed` no se tocan** — ya provenían de `align.score`; cambiarlos habría alterado la semántica de avance/reintento.
- **Esperar el LLM solo en fallo** — en éxito no hay `coachLine` que hablar, así que la latencia del refino es invisible; en fallo se solapa con la repetición en audio.

## Riesgos

- **Refino tardío o proveedor caído** — tope de 10 s en cliente y 20 s en servidor → fallback determinista; nunca cuelga el flujo.
- **Carrera entre refino y siguiente intento** — guard por `attemptId` + `flowToken` descarta refinaciones de intentos ya no vigentes.
- **Crecimiento del registro en memoria** — TTL de 60 s + techo de entradas limitan el uso.
- **Whisper `spawnSync` sigue en el camino crítico** — fuera de alcance; documentado como techo de latencia restante.
