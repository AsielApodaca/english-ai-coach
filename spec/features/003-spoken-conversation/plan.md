# 003 · Conversación hablada natural — Plan

## Enfoque

Reciclar los bloques ya existentes en vez de crear un orquestador nuevo:
- `/api/chat` (texto libre, con memoria del aprendiz) como base del turno.
- `evaluateFragment` (001) como "corrección sobre la marcha": el turno conversacional envía el mensaje del usuario al LLM con instrucciones de que, si hay un error importante, lo corrija como lo haría un humano — no como veredicto de fragmento.
- STT (whisper local o browser) + TTS ya conectados en el frontend de práctica; se reutilizan en el chat hablado.
- `storage`/`Session` para persistir la conversación y alimentar `buildLearnerMemory`.

## Implementación

1. **Backend — turno de conversación** (`src/lib/practice.ts` o nuevo `src/lib/conversation.ts`):
   - Función `conversationTurn(history, userText, learnerMemory)` que arma el prompt con el historial (`history: [{role, content}]`) y devuelve `{ reply, corrected?, score? }` con JSON robusto (reusar `extractJSON`).
   - Instruir al LLM: responder naturalmente; si detecta un error grave (gramática/vocabulario), darlo de forma natural y sugerir la forma correcta; no transformarse en un evaluador de fragmentos salvo que el usuario pida evaluación explícita.
   - Favorecer respuestas hablables cortas (turno de conversación, no ensayo).
2. **Backend — modo Interview**: `interviewSession(category, level, learnerMemory)` genera 4-6 preguntas encadenadas (reusa la generación de 001), con follow-up según la última respuesta y `interviewScore(sessions)` compuesto al terminar.
3. **Frontend — chat hablado** (`public/app.js` + tab `chat`):
   - Botón de micrófono en la fila del chat: graba (Whisper/browser igual que práctica), transcribe, envía `/api/chat`, muestra subtítulo "You" en vivo y reproduce la respuesta con `tts.speak` (orden: TTS → micrófono desbloqueado).
   - Mantener el input de texto como fallback y modo silencioso.
   - Botón "Interview" que entra en modo encadenado y muestra puntuación compuesta al final.
4. **Persistencia**: al cerrar el chat hablado o terminar interview, guardar `Session` (ícono: `fullAnswer`/`fragments` según modo) y dejar que `updateProfile`/`buildNextStep` existentes corran.

## Decisiones

- **Un solo endpoint** (`/api/chat` ampliado con `history` + flags) en vez de dos — evita duplicar prompting y mantiene el fallback de proveedores.
- **Corrección "humana", no veredicto**: se diferencia de la evaluación de 001; la evaluación explícita se dispara solo si el usuario la pide (o en modo interview).
- **TTS antes que micrófono**: para no pisar la voz al detener STT; la UI desbloquea el botón tras terminar de hablar.
- **Whisper preferido** cuando esté disponible (feature 002); pipa `/api/transcribe` ya existente.

## Riesgos

- **Latencia del LLM en turno hablado**: máximo `maxTokens` acotado y respuestas cortas en el prompt; el subtítulo "…" indica que la IA está pensando.
- **Corrección molesta**: se limita a errores graves; el LLM debe no corregir todo (prompt explícito), de lo contrario la conversación se vuelve tediosa.
- **Sin streaming en whisper**: no hay interrupt mientras la IA habla (límite conocido, fuera de alcance).