# 003 · Conversación hablada natural — Tareas

## Backend

- [ ] `conversationTurn(history, userText, learnerMemory)`: prompt de turno conversacional con corrección "humana" sobre la marcha (reusa `extractJSON`), respuestas hablables cortas.
- [ ] Ampliar `/api/chat` para recibir `history` (y flags `mode=chat|interview`) en vez de reemplazarlo.
- [ ] `interviewSession(category, level, learnerMemory)`: 4-6 preguntas encadenadas (reusa generación de 001).
- [ ] `interviewScore(sessions)`: puntuación compuesta al terminar la interview.
- [ ] Persistir el chat hablado/interview como `Session` y alimentar `updateProfile`/`buildNextStep`.

## Frontend

- [ ] Botón de micrófono en la fila del chat (reusa `WaveRecorder`/`BrowserSTT` y `/api/transcribe`).
- [ ] Subtítulo "You" en vivo mientras el usuario habla; respuesta del coach con `tts.speak`.
- [ ] Orden TTS → desbloquear micrófono (no pisar la voz).
- [ ] Botón "Interview" con modo encadenado y puntuación compuesta al final.
- [ ] Fallback a texto si STT/TTS no disponibles; aviso claro.

## Integración / tests

- [ ] Tests `node:test` para `conversationTurn` (prompt/JSON robusto) e `interviewScore`.
- [ ] Validar turno hablado E2E en Chrome (browser STT) y con whisper si está instalado.
- [ ] Validar contra criterios de aceptación de spec.md.
- [ ] Mover la feature a "Hecho" en `../../constitution/roadmap.md`.