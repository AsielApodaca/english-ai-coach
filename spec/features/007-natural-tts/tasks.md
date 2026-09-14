# 007 · Voz humana (TTS neural local) — Tareas

## Núcleo (`src/lib/piper.ts`)

- [x] `checkPiper(baseDir)` → `{ available, voiceReady, hint }` (patrón `whisper.ts`).
- [x] `downloadVoice(model)`: bajar `.onnx` + `.json` (RHVoice) a `models/piper/`.
- [x] `synthesize(text, modelPath, {lengthScale})` → subprocess `piper`, devuelve WAV buffer.
- [x] Soporte de pausa: concatenar WAVs con silencio para "Repeat after me… [pause] …fragment".

## Server

- [x] `GET /api/tts?text=&voice=` → WAV binario (`audio/wav`); pipeline check→synthesize→cache en `data/tmp` y `rm` post-servida.
- [x] Límite de texto por request (≤1000 chars); si piper falta → `503` con error claro.

## Frontend (`public/speech/browser-tts.js`)

- [x] `speak()` multicapa: Piper (`<audio>`) → edge-tts → `speechSynthesis`.
- [x] `stop()` cancela audio/speech actual.
- [x] Misma API (`speak(text, {rate, voice})`); `autoplayFragment` y `speakCoachFeedback` sin cambios.
- [x] Settings: fila de estado TTS (piper/edge/browser) + selector de voz Piper (opcional: `amy`).

## Setup / cierre

- [x] `scripts/setup.sh --tts`: `pipx install piper-tts` + descarga de voz EN.
- [x] `OFFLINE_MODE` (006) fuerza Piper/local, nunca edge-tts.
- [x] Validar contra criterios de aceptación de spec.md.
- [x] Mover la feature a "Hecho" en `../../constitution/roadmap.md`.