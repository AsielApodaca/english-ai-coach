# 001-ejemplo · Pintado incremental de la evaluación de fragmentos — Tareas

- [ ] Descomponer `evaluateFragment` en `evaluateFragmentDeterministic` + `refineWithLLM` + `mergeLLMFeedback` en `src/lib/practice.ts`, conservando `evaluateFragment` como composición para `POST /api/evaluate`.
- [ ] Crear `src/lib/refinement.ts` con el registro en memoria (TTL 60 s, techo de entradas, `attemptId = randomUUID()`).
- [ ] Modificar `POST /api/attempt` en `src/server.ts`: persistir la evaluación determinista, lanzar el refino en background y responder con `attemptId`.
- [ ] Agregar `GET /api/attempt/:id/feedback` con long-poll, timeout de servidor (~20 s) y 404 para id desconocido.
- [ ] Parchar `question.eval` y recalcular el perfil cuando el refino aterriza sobre un intento `full`.
- [ ] Actualizar `public/ui/practice-view.js`: `attemptId` en `outcomeFromJson`, disparo sin `await` del refino y recoloreo guarded por `attemptId` + `flowToken`.
- [ ] Implementar en el camino de fallo la espera del `coachLine` refinado (tope 10 s) solapada con `replayUserWav`.
- [ ] Cubrir el modo texto (`submitText`) y el fallback de browser STT con el mismo contrato de `attemptId`.
- [ ] Tests: evaluación determinista sin LLM, merge de refino (naturalness/verdict/forcedAmber) y registro de refinación (resolve, reject → `refined:false`, 404, TTL).
- [ ] Ejecutar `npm test` y `npm run check` hasta dejarlos en verde.
- [ ] Prueba manual en browser: semáforo sin esperar al LLM, amber y `coachLine` al llegar, pass/fail idéntico.
- [ ] Prueba manual sin ningún proveedor LLM: flujo completo con feedback determinista y sin cuelgues.
- [ ] Actualizar documentación si aplica.
- [ ] Validar contra los criterios de aceptación de spec.md.
- [ ] Mover la feature a "Hecho" en ../../constitution/roadmap.md.
