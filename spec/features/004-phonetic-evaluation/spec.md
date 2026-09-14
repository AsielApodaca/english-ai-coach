# 004 · Evaluación fonética por audio

**Estado:** backlog (no iniciado)

## Qué hace

Evaluar la pronunciación analizando el audio real (fonemas, estrés, ritmo, entonación), no solo la transcripción. Un sidecar local Python (parselmouth/librosa) recibe el WAV y devuelve el análisis fonético; si no está disponible, la evaluación degrada a solo transcripción (word-match + LLM).

## Por qué

La misión exige que la pronunciación se evalúe por fonética/audio, no por transcripción. Los errores de pronunciación son específicos de fonemas; detectar el fonema confundido (ship/sheep, present/present, th, -ed) permite corregir de forma dirigida.

## Criterios de aceptación

- [ ] Sidecar Python (`/pronounce`) recibe WAV y devuelve fonemas detectados, estrés, ritmo y entonación con score.
- [ ] La evaluación combina el análisis fonético con el word-match: score único 0-100.
- [ ] Categoría 'pronunciation' reporta el fonema concreto confundido y cómo corregirlo (p. ej. /i:/ vs /ɪ/).
- [ ] Si el sidecar falta o falla, el flujo degrada a evaluación por transcripción sin romperse.
- [ ] Estado del sidecar (instalado/disponible) visible en Settings, igual que whisper.
- [ ] Generar práctica con objetivo fonético cuando el perfil detecta el gap (mínimos pares, sílabas problemáticas).

## Fuera de alcance

- Visualización de posiciones articulatorias con imágenes.