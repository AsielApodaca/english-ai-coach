# 004 · Evaluación fonética por audio

**Estado:** backlog (no iniciado)

## Qué hace

Evaluar la pronunciación analizando el audio real (fonemas, estrés, ritmo, entonación), no solo la transcripción. Un sidecar local Python (parselmouth/librosa + diccionario fonético CMUdict) recibe el WAV grabado a 44.1/48 kHz y devuelve el análisis fonético con timestamps por palabra; el core Node compara contra el texto objetivo y consolida un score único, con degradación limpia a solo transcripción si el sidecar no está disponible.

## Por qué

La misión exige que la pronunciación se evalúe por fonética/audio, no por transcripción. Los errores de pronunciación son específicos de fonemas; detectar el fonema confundido (ship/sheep, present/present, th, -ed) y el estrés/ritmo permite corregir de forma dirigida y medir mejora real.

## Enfoque elegido

**whisper + CMUdict + parselmouth** (alineación determinística, sin torch):
- `whisper-cli` (ya instalado por la 002) con `-jt` da word-level timestamps de lo que se dijo.
- **CMUdict** mapea cada palabra objetivo y cada palabra dicha → secuencia de fonemas (ARPA).
- **parselmouth/librosa** extrae de cada segmento: pitch (f0), formantes, duración y energía → estrés/entonación/ritmo.
- El core Node alinea los fonemas objetivo vs dichos (secuencia) y consolida: score de fonemas (acierto/confusión), métricas prosódicas y gaps.

## Criterios de aceptación

- [ ] Sidecar Python (`/pronounce`, HTTP local) recibe WAV (44.1k/48k mono) y devuelve `{ words: [{word, start, end, phonemes[]}], prosody: [{start, end, f0, energy}], durationMs }`.
- [ ] El core Node convierte `phonemes` ARPA → corrección (p. ej. `/i:/ vs /ɪ/`) usando CMUdict sobre el texto objetivo y lo dicho.
- [ ] Score compuesto 0-100: combina word-match (001), acierto fonémico y grado prosódico.
- [ ] Categoría 'pronunciation' reporta el fonema concreto confundido y la sugerencia de cómo corregirlo.
- [ ] Si el sidecar falta o falla, el flujo degrada a evaluación por transcripción (word-match + LLM, exactamente como hoy) sin romper la sesión.
- [ ] Estado del sidecar (instalado/disponible) visible en Settings como el de Whisper.
- [ ] Generar práctica con objetivo fonético cuando el perfil detecta el gap (mínimos pares, sílabas problemáticas).
- [ ] Sin dependencias npm nuevas; el sidecar corre vía subprocess/HTTP local (patrón de `whisper.ts`).

## Fuera de alcance

- Visualización de posiciones articulatorias con imágenes.
- Alineación fonémica estilo Montreal Forced Aligner (requiere torch; se documenta como mejora futura).
- Evaluación por video/gestos.