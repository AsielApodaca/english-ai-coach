# 004 · Evaluación fonética por audio — Tareas

## Sidecar Python (`phonetics-python/`)

- [ ] requirements.txt (parselmouth, librosa, numpy, cmudict) + README de instalación.
- [ ] `GET /health` → estado del sidecar.
- [ ] `POST /pronounce` (WAV) → `{ words: [{word, start, end, phonemes[]}], prosody, durationMs }` (whisper `-jt` → parselmouth f0/formantes → CMUdict).
- [ ] Resample interno del WAV (44.1k/48k → 16k para whisper).
- [ ] `npm run setup` agrega paso opcional para instalar el sidecar.

## Core Node

- [ ] `src/lib/phonetics.ts`: cliente HTTP del sidecar + detección de disponibilidad (`checkPhonetics`, patrón `checkWhisper`).
- [ ] `evaluatePronunciation(phonemes, target, userText)`: matriz de confusión fonémica + score.
- [ ] `combineScores(phonetic, wordMatch, llmFeedback)` → score único 0-100 con `pronunciation` en issues.

## Server / UI

- [ ] `POST /api/pronounce` (reusa WAV de `/api/transcribe`); `/phonetics/status`.
- [ ] `/api/health` incluye estado del sidecar.
- [ ] Settings: fila de estado del sidecar (instalado/disponible + hint).
- [ ] Sugerencia del fonema confundido en el feedback (categoría `pronunciation`).
- [ ] Fragmento con objetivo fonético (mínimos pares/sílabas) cuando el perfil detecta el gap.

## Tests / cierre

- [ ] Tests `node:test`: cliente con sidecar mock, `combineScores`, degradación sin sidecar.
- [ ] Validar contra criterios de aceptación de spec.md.
- [ ] Mover la feature a "Hecho" en `../../constitution/roadmap.md`.