# 007 · Voz humana (TTS neural local) — Tareas

## Núcleo (`src/lib/piper.ts`)

- [ ] `checkPiper(baseDir)` → `{ available, voiceReady, hint }` (patrón `whisper.ts`).
- [ ] `downloadVoice(model)`: bajar `.onnx` + `.json` (RHVoice) a `models/piper/`.
- [ ] `synthesize(text, modelPath, {lengthScale})` → subprocess `piper`, devuelve WAV buffer.
- [ ] Soporte de pausa: concatenar WAVs con silencio para "Repeat after me… [pause] …fragment".

## Server

- [ ] `GET /api/tts?text=&voice=` → WAV binario (`audio/wav`); pipeline check→synthesize→cache en `data/tmp` y `rm` post-servida.
- [ ] Límite de texto por request (≤1000 chars); si piper falta → `503` con error claro.

## Frontend (`public/speech/browser-tts.js`)

- [ ] `speak()` multicapa: Piper (`<audio>`) → edge-tts → `speechSynthesis`.
- [ ] `stop()` cancela audio/speech actual.
- [ ] Misma API (`speak(text, {rate, voice})`); `autoplayFragment` y `speakCoachFeedback` sin cambios.
- [ ] Settings: fila de estado TTS (piper/edge/browser) + selector de voz Piper (opcional: `amy`).

## Setup / cierre

- [ ] `scripts/setup.sh --tts`: `pipx install piper-tts` + descarga de voz EN.
- [ ] `OFFLINE_MODE` (006) fuerza Piper/local, nunca edge-tts.
- [ ] Validar contra criterios de aceptación de spec.md.
- [ ] Mover la feature a "Hecho" en `../../constitution/roadmap.md`.