# 004 · Evaluación fonética por audio — Plan

## Enfoque

Arquitectura modular ya acordada (ver `tech-stack.md`): sidecar Python local como servicio HTTP que hace el análisis acústico; el core Node orquesta y consolida el score. Se elige **whisper + CMUdict + parselmouth** (sin torch):

- Determinístico para la base del score (alineación fonémica por diccionario), independiente del LLM.
- Reusa el binario y el modelo de whisper que la feature 002 ya instala (`-jt` para timestamps).
- Degradación limpia: sidecar ausente → evaluación por transcripción sin cambios de flujo.

## Componentes

1. **Sidecar (`phonetics-python/`)** — servidor local (p.ej. Flask/FastAPI mínimo o HTTP stdlib) que expone:
   - `GET /health` → disponibilidad.
   - `POST /pronounce` (WAV) → `{ words: [{word, start, end, phonemes[]}], prosody: [{start, end, f0, energy}], durationMs }`.
   - Internos: `whisper-cli -jt -oj` (word timestamps) → parselmouth (f0/formantes) → CMUdict (fonemas ARPA por palabra).
2. **Core Node (`src/lib/phonetics.ts`)** — cliente del sidecar:
   - Detecta disponibilidad (ping `/health` al arrancar, como `checkWhisper`).
   - `evaluatePronunciation(phonemes, target, userText)` → corrige fonemas (STT itens basta para realce): matriz de confusión fonémica (objetivo vs dicho), score.
   - `combineScores(phonetic, wordMatch, llmFeedback)` → score único 0-100 con `pronunciation` en issues.
3. **Server (`src/server.ts`)** — endpoint `POST /api/pronounce` (reusa el WAV ya subido en `/api/transcribe`): llama al sidecar, consolida y devuelve el fonema confundido + sugerencia. Estado del sidecar en `/api/health` y `/phonetics/status`.
4. **Settings UI** — fila de estado del sidecar igual a Whisper (instalado/disponible + hint `pip install -r phonetics-python/requirements.txt`).
5. **Práctica con objetivo fonético** — cuando el perfil detecta un gap (debilitamiento `pronunciation`), la generación incluye un fragmento de mínimos pares/sílabas problemáticas.

## Integración

- El WAV se graba a 44.1/48 kHz mono PCM16 (`recorder-wave.js`); el sidecar hace resample interno a lo que precise (16k para whisper, 44.1k para parselmouth).
- Se invoca en el mismo momento que hoy `/api/transcribe`: primero el sidecar (si está), luego word-match + LLM. Sin sidecar → solo transcripción.
- Sin nuevas deps npm; Python en requirements.txt (parselmouth, librosa, numpy, cmudict).

## Riesgos

- **Timestamps imperfectos** de whisper → tolerancia en la ventana de segmento; si no hay match confiable, degrada esa palabra a transcripción sin terminar la sesión.
- **Grabación ruidosa/entorno** → el preprocesado (librosa) normaliza; si SNR es baja, score prosódico se descuenta, no rompe.
- **Sidecar no instalado** → degradación ya definida; la feature sigue siendo útil sin él.
- **CMUdict no cubre todas las palabras técnicas** → fallback: marcar sin fonematizar (contado neutral, no penaliza).

## Pasos

1. Repo: `phonetics-python/` con requirements.txt y README de instalación (opcional, `npm run setup` lo instala si se elige).
2. Sidecar `/pronounce` + `/health`.
3. `src/lib/phonetics.ts` (cliente + alineación/score).
4. `/api/pronounce` + status en health.
5. UI: fila status + texto de sugerencia en el feedback.
6. Fragmento con objetivo fonético en generación.
7. Tests (`node:test`): cliente con sidecar mock, `combineScores`, fallback sin sidecar.