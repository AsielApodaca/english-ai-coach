# 002 · Whisper local predeterminado — Tareas

## Backend / infra (hecho en 001)

- [x] `scripts/setup.sh`: instalar `whisper-cpp` (Homebrew) + descargar modelo GGML (`WHISPER_MODEL`) en `models/`.
- [x] `src/lib/whisper.ts`: `checkWhisper`, `downloadModel`, `transcribeWav`.
- [x] `src/server.ts`: `POST /api/transcribe` + `GET /api/whisper/status` + `/api/health` con `whisper.available`/`modelReady`.
- [x] Frontend: grabadora WAV (`recorder-wave.js`) y flujo whisper en `startRecording`/`btn-stop`.

## Default + fallback (feature 002)

- [ ] Auto-seleccionar `whisper` como STT por defecto cuando esté listo y el usuario no haya elegido otro motor antes.
- [ ] Fallback a BrowserSTT ante error de `/api/transcribe` (sin romper el flujo, aviso único).
- [ ] Settings: marcar "Whisper (local)" como preferido/recomendado cuando está listo; hint de instalación si no.
- [ ] Tests `node:test` para la lógica pura de elección de motor (`pickStt(health, userChoice)`).

## Cierre

- [ ] Validar contra criterios de aceptación de spec.md.
- [ ] Mover la feature a "Hecho" en `../../constitution/roadmap.md`.