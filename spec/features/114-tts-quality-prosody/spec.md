# 114 · Calidad de voz del coach: prosodia y cadena existente

**Estado:** especificado 📋 (ola 7 — pendiente de implementar)

## Contexto

- Caso de uso: CU2 — todo lo que dice el coach (pregunta, respuesta modelo, fragmentos, feedback); objetivo del producto: "conversación por audio, fluida y de naturaleza humana" (`../../use-cases/CU2.md` "Objetivo").
- Pantallas: dock de audio (tempo/volumen, `../../design/design-system.md`), pill "Speech Engine" en settings.
- Base:
  - Cadena: **Piper (local) → edge-tts (online) → `speechSynthesis` (browser)** — resolución en `ttsStatus()` de `src/server.ts`.
  - `GET /api/tts` (`src/server.ts`) — ya soporta **`segments[]` + `pauseAfterMs`** (síntesis multi-segmento con silencios medidos) y `rate` 0.5–2. **Ningún caller los usa hoy.**
  - `src/lib/piper.ts` — `synthesize` (WAV, `--length-scale = 1/rate`, silencio final), `synthesizeSegments` + `concatWavWithPauses` (existe, sin uso).
  - `src/lib/edge-tts.ts` — MP3, `--rate`, voz `en-US-AriaNeural`.
  - `public/ui/practice-view.js` — `speakWithKaraoke()` (fetch `/api/tts`, `<audio>` + karaoke lineal), `speak()`.
  - `public/speech/browser-tts.js` — capa server + fallback browser.
- Decisiones registradas (sesión de especificación): **mejorar la prosodia sobre la cadena existente** (sin cambiar de motor): pausas humanas, caché, normalización; alternativas de motor descartadas por ahora.

## Qué hace

Mejora la calidad percibida de la voz del coach atacando las tres causas reportadas —**voz mecánica, estática y ausencia de pausas humanas**— dentro de la cadena TTS actual, sin migrar de motor:

1. **Pausas humanas reales** entre cláusulas (coma/punto/final) explotando `segments` + `pauseAfterMs` (capacidad ya construida y sin uso).
2. **Limpieza de artefactos** (clicks, clipping, desajuste de sample-rate) con normalización de nivel y fades.
3. **Caché de síntesis** para eliminar el glitch de re-síntesis (el mismo texto se sintetiza distinto en cada request y las repeticiones "crujen"/se saltan).
4. **Diagnóstico y preferencia de motor** para que no se caiga silenciosamente al `speechSynthesis` del navegador (la fuente más mecánica) y para que el setting de voz (`engcoach.voice`) deje de ser inerte.

## Por qué

- **Mecanicidad:** Piper/edge leen de corrido sin las micro-pausas que hace un hablante humano entre ideas → suena a robot aunque la voz sea neural.
- **Estática:** la evidencia apunta a normalización/peak clipping, `decodeAudioData` con sample-rate distinto al `AudioContext`, y re-síntesis no cacheada (cada render puede diferir); el browser fallback agrava el problema.
- **Pausas:** una frase de 20 palabras leída sin pausas cansa la comprensión; el learner necesita tiempo de procesamiento entre fragmentos.

## Requerimientos funcionales

### Diagnóstico previo (gate de implementación)

- [ ] **Identificar el motor activo en el entorno del usuario** (`GET /api/tts/status` / `health.tts`) y registrar en el spec/PR qué motor produce la estática reportada (Piper WAV, edge MP3 o browser). Si el motor activo es `browser`, la causa principal de "mecánica + estática" es el fallback y la prioridad pasa a garantizar Piper/edge disponibles (ver §Motor).

### Pausas humanas (prosodia)

- [ ] **Partidor de cláusulas puro:** nuevo módulo `src/lib/prosody.ts` con `splitForTts(text) → { segments: string[], pausesMs: number[] }`:
  - Divide en cláusulas en `, ; : —` (pausa corta, ~180–250 ms), `. ? !` (pausa media, ~350–450 ms) y final de oración larga (~600–700 ms).
  - Respeta abreviaturas (`Mr.`, `e.g.`), números (`3.5`) y comillas/corchetes; no genera segmentos vacíos; si el texto es corto (≤ ~4 palabras) no se divide.
  - Límite de segmentos (p. ej. ≤ 12) para no colapsar el endpoint.
- [ ] **Uso en las locuciones del coach:** el fragmento/pregunta/modelo/feedback se envía a `/api/tts` como `segments[]` + pausas → el server devuelve **un solo archivo** (Piper `concatWavWithPauses` ya concatena; edge concatena igual considerando codec — ver Decisiones si requiere ajuste). El karaoke recibe un único audio, igual que hoy.
- [ ] **Respeto al karaoke:** la animación de palabras (`animateWordProgress`, lineal por duración) puede desviarse tras cada pausa. Mitigación: pausas cortas por defecto (valores de arriba son el techo, se pueden ajustar tras prueba A/B manual) y, si la desviación resulta > ~150 ms por línea en pruebas, distribuir el tiempo de la pausa dentro de la palabra frontera (documentar el resultado de la prueba en el PR).
- [ ] **Rate preservado:** el tempo del dock sigue aplicándose server-side (`lengthScale`/`--rate`) sobre los segmentos; el tempo no altera los offsets de pausa (pausas fijas en ms).

### Limpieza de audio

- [ ] **Normalización de nivel (WAV/Piper):** ganancia por RMS/peak hacia un objetivo (p. ej. −16 a −14 dBFS con peak ≤ −1 dBFS) aplicada a la salida WAV de Piper; sin clipping.
- [ ] **Fades anti-click:** fade-in/out de 5–10 ms en cada archivo servido (y por segmento concatenado) para eliminar pops de inicio/fin.
- [ ] **Sample-rate coherente:** servir/decodificar al sample-rate del `AudioContext` de reproducción (o dejar que `decodeAudioData` resamplee de forma consistente) — documentar la causa raíz encontrada en el diagnóstico y su fix.
- [ ] **edge-tts (MP3):** normalización de nivel en el cliente (gain node) cuando el motor activo sea edge, ya que el pipeline server-side de este spec trabaja sobre WAV; documentar la limitación.

### Caché de síntesis

- [ ] **Caché server-side LRU** de síntesis: clave `sha1(engine|voice|rate|segments|pauses)` → archivo en `data/tmp/tts-cache/` (o en memoria con límite, p. ej. 100 entradas / 50 MB, **nunca** en el repo). Evita re-sintetizar el mismo fragmento en cada reintento/loop.
- [ ] **Invalidación:** TTL razonable (p. ej. 24 h) + purge en arranque de `data/tmp`; la caché es descartable (si no existe, se resintetiza).
- [ ] **Acotada:** respeta `TTS_MAX_CHARS = 1000` y el límite de segmentos antes de consultar la caché.

### Motor y settings

- [ ] **El setting `engcoach.voice` deja de ser inerte:** `speakWithKaraoke`/`BrowserTTS` envían la voz elegida a `/api/tts` (hoy el frontend nunca pasa `voice`); el server ya valida contra `SUPPORTED_VOICES`. Si el valor es "Auto", se mantiene la cadena actual.
- [ ] **Visibilidad de degradación:** si el motor activo es `browser` (el de peor calidad), el pill "Speech Engine" lo muestra claramente (ya existe `BROWSER`) — verificar que el usuario puede descubrir que necesita Piper/edge para buena calidad (`npm run setup`).
- [ ] **Sin regressión de red/caída:** la cadena de fallback Piper→edge→browser y los 503 del `/api/tts` siguen funcionando idéntico.

## Requerimientos no funcionales

- Presupuesto $0: sin TTS de pago; sin dependencias npm nuevas.
- `data/tmp/` es descartable y **no** se commitea (ya está en `.gitignore`).
- Latencia: caché hit < 50 ms; miss dentro del rango actual de síntesis.
- El karaoke no se retrasa perceptiblemente (la síntesis sigue siendo pre-roll antes de `captureAttempt`).

## Decisiones de diseño / tecnología

- **Prosodia sobre cadena existente vs motor nuevo:** elegido prosodia (decisión del usuario). Alternativa descartada (documentada): migrar a Kokoro/otro motor — reevaluar si tras esta feature la calidad sigue insuficiente.
- **Un solo archivo con pausas internas** vs reproducción de N audios en serie: elegido archivo único — conserva el contrato de `speakWithKaraoke` (1 fetch, 1 duración, karaoke lineal) y evita gap/clicks entre `<audio>`.
- **Pausas fijas por signo de puntuación** vs pausas aprendidas de un modelo: fijas y testeables; los valores iniciales son un punto de partida medible.
- **Caché en `data/tmp` + LRU** vs caché en repo: tmp (descartable, sin binarios versionados).
- **Edge MP3 sin normalización server-side:** aceptado; mitigado con gain en cliente (documenta la asimetría).

## Dependencias

- 007 (Piper/edge/browser — proveedores TTS).
- 105 (`speakWithKaraoke`, karaoke) — consumidor de `segments`.
- 113 (click de palabra) — aprovecha la misma caché de síntesis.

## Criterios de aceptación

- [ ] `tests/prosody.test.ts` (nuevo, puro): `splitForTts` — división por cláusulas, pausas asignadas (ms por tipo de signo), abreviaturas/números intactos, texto corto sin dividir, límite de segmentos, sin segmentos vacíos. ≥ 10 casos.
- [ ] Tests de caché: hit/miss con engine/voice/rate distintos (misma clave ⇒ hit), invalidación TTL, límite LRU evict, no cachea errores.
- [ ] Tests de normalización WAV: peak ≤ target, sin clipping, fades aplicados (usable con los helpers WAV existentes de `tests/piper.test.ts`).
- [ ] `tests/piper.test.ts`/`tests/edge-tts.test.ts` siguen verdes (sin romper la cadena existente).
- [ ] `npm test` y `npm run check` verdes (archivos nuevos listados en `package.json`).

## Checklist de verificación (pre-merge)

- [ ] **Diagnóstico documentado en el PR:** motor activo identificado y causa de la estática confirmada (con/ sin fix).
- [ ] Escucha A/B: mismo fragmento con pausas vs sin pausas (toggle de feature flag o commit previo) — el "con pausas" suena a hablante, no a ráfaga.
- [ ] Karaoke: el resaltado de palabras no se desincroniza visiblemente tras las pausas (medir desviación por línea; si > ~150 ms aplicar la mitigación y documentarlo).
- [ ] Repetir el mismo fragmento (reintento) → respuesta de audio **instantánea** desde caché y **idéntica** byte a byte (sin "crujidos" de re-síntesis).
- [ ] Sin clipping audibles en los picos (feedback del coach "Great job…" y fragmentos largos) y volumen consistente entre fragmentos.
- [ ] Tempo 0.75/1/1.25 sigue funcionando con segments (rate aplicado server-side).
- [ ] Volumen del coach (10–100%) sigue aplicándose en vivo.
- [ ] Setting "Voz del coach" con una voz concreta → efecto audible (ya no inerte); "Auto" → cadena actual.
- [ ] Cadena de fallback intacta: matar Piper/edge → sigue funcionando con el siguiente motor; `/api/tts` 503 → fallback browser como hoy.
- [ ] `data/tmp/tts-cache/` no aparece en `git status` (gitignore correcto) y la caché no crece sin límite tras 100 síntesis.
- [ ] Review de voz con y sin `OFFLINE_MODE` (edge excluido en offline).

## Fuera de alcance

- Cambiar/migrar de motor TTS (Kokoro, ElevenLabs, etc.) — reevaluar solo si esta feature no alcanza la calidad.
- Emoción/entonación contextual dependiente del LLM (p. ej. entonar pregunta vs afirmación con SSML avanzado) — extensión futura documentable.
- Caché de audio del usuario o de la transcripción.
- Cambiar la voz por fragmento o por rol.

## Recursos

- `src/server.ts` (`/api/tts`, `ttsStatus`), `src/lib/piper.ts` (`synthesizeSegments`, `concatWavWithPauses`), `src/lib/edge-tts.ts`, `src/lib/prosody.ts` (nuevo), `public/ui/practice-view.js` (`speakWithKaraoke`), `public/speech/browser-tts.js`, `tests/piper.test.ts`, `spec/use-cases/CU2.md`.
