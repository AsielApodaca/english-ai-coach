# 007 · Voz humana (TTS neural local) — Plan

## Enfoque

La app hoy envía todo texto hablable a `speak(text)` (`public/speech/browser-tts.js` → `speechSynthesis`). Se introduce un motor TTS neural local (**Piper**) detrás de la misma interfaz, para no tocar la orquestación. Piper genera WAV (PCM16) por subprocess; el navegador lo reproduce vía `<audio>`; sin dependencias npm nuevas.

Cadena de motor: `Piper (local) → edge-tts (online, fallback) → speechSynthesis (último recurso)`.

## Componentes

1. **`src/lib/piper.ts`** (patrón `whisper.ts`):
   - `checkPiper(baseDir)`: binario `piper` en PATH + voz EN descargada en `models/piper/` (en_US-amy-medium, ~60MB), devuelve `{ available, voiceReady, hint }`.
   - `synthesize(text, modelPath)` → subprocess `piper --model <voz> --output_file <wav>`; devuelve el WAV buffer.
   - `downloadVoice(model)`: baja el modelo `.onnx` + `.json` de HuggingFace (RHVoice) a `models/piper/`.
   - Pausas/prosodia: `synthesize(text, {pausesBetween: ms})` concatena WAVs con silencio — el navegador solo recibe un único WAV (nada de hacks en el frontend). `length_scale` para velocidad.
2. **Server**: `GET /api/tts?text=&pauseAfterMs=&voice=` → WAV binario (content-type `audio/wav`). Pipeline: check piper → synthesize → cache en `data/tmp/` (borrado post-entrega). Si piper falta: `503` con `{ error: intencion de fallback }`.
3. **Frontend (`public/speech/browser-tts.js`)** — `speak()` multicapa:
   - Piper: `fetch("/api/tts?text=")` → `Audio` → resolution al terminar; `pauseAfterMs` para silencio.
   - Si `/api/tts` responde 503/no disponible → edge-tts (CLI `edge-tts` vía pip, sirve el WAV por el mismo endpoint — nunca en OFFLINE_MODE) → si falla → `speechSynthesis`.
   - `stop()` cancela el `<audio>`/speech actual.
   - Misma API: `speak(text, {rate, voice})` — el frontend existente (`autoplayFragment`, `speakCoachFeedback`, chat 003) no cambia.
4. **Settings**: fila de estado TTS (piper ready / edge / browser) + selector de voz Piper (opcional inicial: `amy`).
5. **Setup** (`scripts/setup.sh`): paso opcional `--tts` → `pipx install piper-tts` y descarga de voz EN.

## Decisiones

- **Conmutador solo en el frontend**: el core/no-fun no sabe de TTS; `speak()` decide. Menos acople, igual que STT.
- **Sí a edge-tts** online: da voces humanas sin instalar nada si Piper falta; nunca en `OFFLINE_MODE` (006).
- **No streaming**: WAV completo es suficiente para turnos cortos; la latencia de piper es <1s para frases de práctica.

## Riesgos

- **Piper binario vía pipx en PATH** puede faltar en `npm run setup` → hint claro y degradación a edge/speech.
- **WAV grande en `/api/tts`**: cache en `data/tmp` y `rm` post-servida; límite de texto por request (⩽1000 chars).
- **eabled `autoplay` del navegador**: el audio reproducido solo tras gesto (botón Play); igual que `speechSynthesis` hoy.