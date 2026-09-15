# 003 · Conversación hablada natural — Tareas

## Backend

^- [x] `conversationTurn(history, userText, learnerMemory)`: prompt de turno conversacional con corrección "humana" sobre la marcha (reusa `extractJSON`), respuestas hablables cortas.
^- [x] Ampliar `/api/chat` para recibir `history` (y flags `mode=chat|interview`) en vez de reemplazarlo.
^- [x] `interviewSession(category, level, learnerMemory)`: 4-6 preguntas encadenadas (reusa generación de 001).
^- [x] `interviewScore(sessions)`: puntuación compuesta al terminar la interview.
^- [x] Persistir el chat hablado/interview como `Session` y alimentar `updateProfile`/`buildNextStep`.

## Frontend

^- [x] Botón de micrófono en la fila del chat (reusa `WaveRecorder`/`BrowserSTT` y `/api/transcribe`).
^- [x] Subtítulo "You" en vivo mientras el usuario habla; respuesta del coach con `tts.speak`.
^- [x] Orden TTS → desbloquear micrófono (no pisar la voz).
^- [x] Botón "Interview" con modo encadenado y puntuación compuesta al final.
^- [x] Fallback a texto si STT/TTS no disponibles; aviso claro.

## Integración / tests

^- [x] Tests `node:test` para `conversationTurn` (prompt/JSON robusto) e `interviewScore`.
^- [x] Validar turno hablado E2E en Chrome (browser STT) y con whisper si está instalado.
^- [x] Validar contra criterios de aceptación de spec.md.
^- [x] Mover la feature a "Hecho" en `../../constitution/roadmap.md`.