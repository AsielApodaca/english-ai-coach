# 002 · Whisper local predeterminado

**Estado:** implementado ✅

## Qué hace

whisper.cpp es el motor STT **predeterminado** cuando está instalado y con modelo listo; el reconocimiento del navegador (Web Speech) queda como fallback automático. Detectar binario y modelo, descargar el modelo vía setup, transcribir WAV a texto en local y exponer el estado en `/api/health` y `whisper-status`.

## Por qué

Sin credenciales, sin límites de peticiones, 100% offline y privado: las transcripciones nunca salen de la máquina. Da mejor fidelidad para la evaluación que el reconocimiento del navegador, y encaja con el modo sin conexión (006) y la conversación hablada (003).

## Estado actual (infra/pipeline ya construido)

- `scripts/setup.sh` instala `whisper-cpp` vía Homebrew si falta y descarga el modelo GGML (`WHISPER_MODEL`) bajo `models/`.
- `src/lib/whisper.ts` — `checkWhisper` (binario + modelo listo), `downloadModel`, `transcribeWav` (WAV 16 kHz mono → texto, `-nt -np`).
- `src/server.ts` — `POST /api/transcribe` (raw audio/*) y `GET /api/whisper/status`; `/api/health` expone `whisper.available` / `modelReady`.
- UI: `public/speech/recorder-wave.js` graba y exporta WAV (AudioWorklet/ScriptProcessor, PCM16); el selector `set-stt` permite elegir `browser` o `whisper`; el flujo de grabación con whisper sube el blob a `/api/transcribe`.

## Falta (para cumplir la feature completa)

- Elegir `whisper` automáticamente como motor por defecto cuando `whisper.available && modelReady`, sin forzar selección manual.
- Fallback automático a Web Speech si whisper falla o no está listo (transcribe con error → no romper el flujo).
- En Settings, marcar "Whisper (local)" como preferido/recomendado cuando esté listo, y el estado instalado/no instalado.

## Criterios de aceptación

- [x] `npm run setup` instala `whisper-cpp` (si falta) y descarga el modelo automáticamente.
- [x] `/api/health` reporta `whisper.available` y `modelReady` reales.
- [x] `/api/transcribe` WAV → texto con `whisper-cli`; si el binario falta, error claro con instrucción (`brew install whisper-cpp`).
- [x] La UI permite seleccionar Whisper como motor STT y transcribe en local (subiendo el WAV).
- [x] Whisper se auto-selecciona como motor por defecto cuando está instalado y con modelo listo (si no hay elección previa del usuario).
- [x] Web Speech es fallback automático si whisper falla o no está instalado (flujo nunca se rompe).
- [x] Settings muestra "Whisper (local)" y lo marca como preferido cuando está listo.

## Fuera de alcance

- Streaming de transcripción en tiempo real (solo transcripción de audio grabado).
- Selección de modelo por calidad (tiny/base/small/medium) en la UI (ya soportado vía `WHISPER_MODEL`, sin UI).
- Instalación automática fuera de macOS/Linux con Homebrew.