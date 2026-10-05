# 114 · Calidad de voz del coach: prosodia y cadena existente

**Estado:** implementado 🚧 (verificación manual A/B pendiente — ver Checklist)

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

- [x] **Identificar el motor activo en el entorno del usuario** (`GET /api/tts/status` / `health.tts`) y registrar en el spec/PR qué motor produce la estática reportada (Piper WAV, edge MP3 o browser). Si el motor activo es `browser`, la causa principal de "mecánica + estática" es el fallback y la prioridad pasa a garantizar Piper/edge disponibles (ver §Motor).
  - **Resultado (2026-10-02):** motor activo = **piper** (`en_US-amy-medium`, `voiceReady`; edge-tts no instalado). El WAV muestreado medía **pico −0.00 dBFS con 2 samples recortados** y RMS −17.25 dBFS, sin fades → **causa raíz = peak clipping + ausencia de fades/normalización** (no el sample-rate). Con el fix: pico **−1.00 dBFS, 0 samples recortados**.

### Pausas humanas (prosodia)

- [x] **Partidor de cláusulas puro:** nuevo módulo `src/lib/prosody.ts` con `splitForTts(text) → { segments: string[], pausesMs: number[] }`:
  - Divide en cláusulas en `, ; : —` (pausa corta, ~180–250 ms), `. ? !` (pausa media, ~350–450 ms) y final de oración larga (~600–700 ms).
  - Respeta abreviaturas (`Mr.`, `e.g.`), números (`3.5`) y comillas/corchetes; no genera segmentos vacíos; si el texto es corto (≤ ~4 palabras) no se divide.
  - Límite de segmentos (p. ej. ≤ 12) para no colapsar el endpoint.
  - Implementación canónica en `public/speech/prosody.js` (módulo de navegador importable por Node); `src/lib/prosody.ts` es el re-export tipado → **una sola fuente de verdad** para cliente, servidor y tests. Constantes: 220 / 400 / 650 ms, `MAX_SEGMENTS = 12`, `SHORT_TEXT_MAX_WORDS = 4`.
- [x] **Uso en las locuciones del coach:** el fragmento/pregunta/modelo/feedback se envía a `/api/tts` como `segments[]` + pausas → el server devuelve **un solo archivo** (Piper `concatWavWithPauses` ya concatena; edge concatena igual considerando codec — ver Decisiones si requiere ajuste). El karaoke recibe un único audio, igual que hoy.
  - `speakWithKaraoke` y `BrowserTTS.speak(string)` parten en cliente y envían `segments[]` + `pausesMs[]`; el servidor parte también los textos planos (curl/clients viejos) y valida `pausesMs.length === segments.length` (400 si no).
- [x] **Respeto al karaoke:** la animación de palabras (`animateWordProgress`, lineal por duración) puede desviarse tras cada pausa. Mitigación: pausas cortas por defecto (valores de arriba son el techo, se pueden ajustar tras prueba A/B manual) y, si la desviación resulta > ~150 ms por línea en pruebas, distribuir el tiempo de la pausa dentro de la palabra frontera (documentar el resultado de la prueba en el PR).
  - Implementado **sin esperar al A/B**: `buildWordStarts()` calcula el onset de cada palabra repartiendo el tiempo de habla por segmento e insertando sus pausas (resaltado pausa-aware); si el recuento de palabras no cuadra con los spans → fallback lineal seguro. La medición A/B manual queda en el Checklist.
- [x] **Rate preservado:** el tempo del dock sigue aplicándose server-side (`lengthScale`/`--rate`) sobre los segmentos; el tempo no altera los offsets de pausa (pausas fijas en ms). Verificado: `rate=0.5 → 4.33 s`, `rate=1.5 → 2.01 s`.

### Limpieza de audio

- [x] **Normalización de nivel (WAV/Piper):** ganancia por RMS/peak hacia un objetivo (p. ej. −16 a −14 dBFS con peak ≤ −1 dBFS) aplicada a la salida WAV de Piper; sin clipping.
  - `normalizeWav()` en `src/lib/piper.ts`: RMS objetivo **−15 dBFS**, techo de pico **−1 dBFS** (la ganancia nunca puede recortar), aplicada **por segmento** antes de concatenar. Medido post-fix: **−1.00 dBFS, 0 samples recortados**.
- [x] **Fades anti-click:** fade-in/out de 5–10 ms en cada archivo servido (y por segmento concatenado) para eliminar pops de inicio/fin.
  - `FADE_MS = 8` (lineal, ambos bordes, por frame/estéreo).
- [x] **Sample-rate coherente:** servir/decodificar al sample-rate del `AudioContext` de reproducción (o dejar que `decodeAudioData` resamplee de forma consistente) — documentar la causa raíz encontrada en el diagnóstico y su fix.
  - **Decisión:** se sirve el WAV nativo de Piper (**22050 Hz**); `decodeAudioData`/`<audio>` resamplean de forma consistente. La causa raíz de la estática era el clipping (gate), no el sample-rate → sin resampler server-side.
- [x] **edge-tts (MP3):** normalización de nivel en el cliente (gain node) cuando el motor activo sea edge, ya que el pipeline server-side de este spec trabaja sobre WAV; documentar la limitación.
  - `public/speech/level.js`: mide el blob decodificado (mismas constantes que el servidor), atenúa vía `audio.volume` y **boostea vía gain node** (`AudioContext`); `setElementVolume` aplica el volumen del usuario encima en vivo. Si el contexto no puede arrancar → fallback a `audio.volume` (nunca silencio).

### Caché de síntesis

- [x] **Caché server-side LRU** de síntesis: clave `sha1(engine|voice|rate|segments|pauses)` → archivo en `data/tmp/tts-cache/` (o en memoria con límite, p. ej. 100 entradas / 50 MB, **nunca** en el repo). Evita re-sintetizar el mismo fragmento en cada reintento/loop.
  - `src/lib/tts-cache.ts`: índice en memoria + `.bin` en disco, LRU **100 entradas / 50 MB** (ambos topes), escritura atómica (tmp+rename), cabecera `X-TTS-Cache: hit|miss`.
- [x] **Invalidación:** TTL razonable (p. ej. 24 h) + purge en arranque de `data/tmp`; la caché es descartable (si no existe, se resintetiza).
  - TTL **24 h** por mtime de archivo (sobrevive reinicios); el índice se reconstruye al construir la caché (arranque) purgando lo caducado. Errores **nunca** se cachean.
- [x] **Acotada:** respeta `TTS_MAX_CHARS = 1000` y el límite de segmentos antes de consultar la caché.
  - Validación previa: `TTS_MAX_CHARS = 1000`, `TTS_MAX_SEGMENTS = 40`, `pausesMs.length === segments.length` (validado **contra los segmentos ya limpios**, review #4) → todo ANTES de tocar la caché. El cliente agrupa las selecciones de tokens largas en segmentos de ≤40 palabras (`chunkTokens`) para no chocar con el cap (review #2).

### Motor y settings

- [x] **El setting `engcoach.voice` deja de ser inerte:** `speakWithKaraoke`/`BrowserTTS` envían la voz elegida a `/api/tts` (hoy el frontend nunca pasa `voice`); el server ya valida contra `SUPPORTED_VOICES`. Si el valor es "Auto", se mantiene la cadena actual.
  - `coachVoice()` en la practice view envía `voice` en todas las locuciones; el select de settings ofrece **Auto + `readyVoices`** (voces descargadas, desde `/api/health`). Voz no soportada → 400; soportada pero no descargada → **fallback silencioso a la voz por defecto** (un ajuste viejo degrada en vez de romper la lectura).
- [x] **Visibilidad de degradación:** si el motor activo es `browser` (el de peor calidad), el pill "Speech Engine" lo muestra claramente (ya existe `BROWSER`) — verificar que el usuario puede descubrir que necesita Piper/edge para buena calidad (`npm run setup`).
  - La fila "Speech Engine" de settings ahora muestra el `hint` del server cuando el engine es `browser` (p. ej. `browser (Piper not found. Install with: pipx install piper-tts…)`).
- [x] **Sin regressión de red/caída:** la cadena de fallback Piper→edge→browser y los 503 del `/api/tts` siguen funcionando idéntico.
  - `npm test` (493 tests, 0 fallos) + smoke manual: rutas legacy (`segments` sin `pausesMs`) siguen operativas.

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
- **Partidor compartido cliente+servidor:** la implementación canónica vive en `public/speech/prosody.js` (importable por Node sin build); `src/lib/prosody.ts` re-exporta. El cliente parte para enviar `segments+pausas`; el servidor parte también los textos planos (defensa/curl). Mismo splitter → misma clave de caché.
- **Contrato `pausesMs`:** repeatable, una entrada por segmento, `pausesMs[i]` = silencio **DESPUÉS** del segmento `i` (el último = handover largo). Longitud distinta → 400. `pauseAfterMs` legacy se preserva: entre segmentos (ruta `segments` sin `pausesMs`) o trailing (ruta `text`).
- **Normalización por segmento (Piper):** `normalizeWav` corre antes de concatenar → cada cláusula al objetivo y los bordes internos (junto a los silencios) no crujen. RMS −15 dBFS / pico ≤ −1 dBFS / fades 8 ms / **boost máximo ×4 (+12 dB), la misma constante `MAX_BOOST` que el gain del cliente**. RMS medido sobre el archivo completo queda por debajo del objetivo porque los silencios de pausa lo incluyen — correcto e intencional.
- **Voz efectiva:** `voice` no soportada → 400 (contrato existente); soportada sin modelo → se usa `DEFAULT_VOICE` (degradación silenciosa). `ttsStatus()` expone `voices` + `readyVoices` para el select.
- **Karaoke pausa-aware:** `buildWordStarts()` (onsets por palabra con las pausas insertadas, módulo puro `public/ui/karaoke-schedule.js`) + fallback lineal si el tokenizado no cuadra; se evitó la solución "empujar la pausa a la palabra frontera" porque da el mismo resultado con menos acoplamiento al texto. **Solo se aplica cuando la respuesta lo indica** (`X-TTS-Pauses: measured`, solo Piper): edge sintetiza sin silencios y un schedule pausa-aware ahí adelantaría el resaltado 0.5–1 s (regresión del review #1).
- **Edge: una sola síntesis del texto unido** (sin silencios medidos): insertar silencio PCM requeriría un codificador MP3. Las pausas de prosodia aplican al 100% en Piper; edge queda sin pausas internas (limitación documentada) + gain de cliente.

## Dependencias

- 007 (Piper/edge/browser — proveedores TTS).
- 105 (`speakWithKaraoke`, karaoke) — consumidor de `segments`.
- 113 (click de palabra) — aprovecha la misma caché de síntesis.

## Criterios de aceptación

- [x] `tests/prosody.test.ts` (nuevo, puro): `splitForTts` — división por cláusulas, pausas asignadas (ms por tipo de signo), abreviaturas/números intactos, texto corto sin dividir, límite de segmentos, sin segmentos vacíos, guion entre dígitos = rango numérico (no corte), input solo-puntuación ⇒ 1 segmento (contrato ≥ 1). → **20 tests**
- [x] Tests de caché: hit/miss con engine/voice/rate distintos (misma clave ⇒ hit), invalidación TTL, límite LRU evict, no cachea errores, rechazo de llaves que no son sha1 hex (defensa path traversal). → `tests/tts-cache.test.ts`, 14 tests
- [x] Tests de normalización WAV: peak ≤ target, sin clipping, fades aplicados, boost limitado a `MAX_BOOST` (×4, compartido con el cliente) (usable con los helpers WAV existentes de `tests/piper.test.ts`). → `tests/audio-normalize.test.ts`, 13 tests (+ 10 tests puros del gain de cliente en `tests/level.test.ts`)
- [x] Tests del schedule de karaoke y del chunking de selecciones largas (regresiones del review PR #28): `tests/karaoke-schedule.test.ts` (4) + `tests/browser-tts.test.ts` (12, incluye selección de ~60 tokens en 2 segmentos).
- [x] `tests/piper.test.ts`/`tests/edge-tts.test.ts` siguen verdes (sin romper la cadena existente).
- [x] `npm test` y `npm run check` verdes (archivos nuevos listados en `package.json`). → **493 tests, 0 fallos (2 skips por piper instalado/no instalado)**

## Checklist de verificación (pre-merge)

- [x] **Diagnóstico documentado en el PR:** motor activo identificado y causa de la estática confirmada (con/ sin fix). → motor piper; causa = peak clipping (−0.00 dBFS, 2 recortados) → fix: −1.00 dBFS, 0 recortados.
- [ ] **Escucha A/B manual:** mismo fragmento con pausas vs sin pausas (toggle de feature flag o commit previo) — el "con pausas" suena a hablante, no a ráfaga. *(pendiente — requiere oído humano)*
- [ ] **Karaoke:** el resaltado de palabras no se desincroniza visiblemente tras las pausas (medir desviación por línea; si > ~150 ms aplicar la mitigación y documentarlo). *Mitigación ya implementada (`buildWordStarts`); queda la medición manual.*
- [x] Repetir el mismo fragmento (reintento) → respuesta de audio **instantánea** desde caché y **idéntica** byte a byte (sin "crujidos" de re-síntesis). → verificado con curl: `X-TTS-Cache: hit` + `cmp` byte a byte.
- [ ] Sin clipping audibles en los picos (feedback del coach "Great job…" y fragmentos largos) y volumen consistente entre fragmentos. *Medido sin clipping (0 samples); audición manual pendiente.*
- [x] Tempo 0.75/1/1.25 sigue funcionando con segments (rate aplicado server-side). → medido 0.5→4.33 s / 1.5→2.01 s.
- [x] Volumen del coach (10–100%) sigue aplicándose en vivo. → `setElementVolume` (gain node o `audio.volume`), tests de `setVolume` verdes.
- [ ] Setting "Voz del coach" con una voz concreta → efecto audible (ya no inerte); "Auto" → cadena actual. *Cableado verificado en servidor (200 con voz lista, fallback con voz no descargada); audición manual pendiente.*
- [x] Cadena de fallback intacta: matar Piper/edge → sigue funcionando con el siguiente motor; `/api/tts` 503 → fallback browser como hoy. → mismos caminos + tests de BrowserTTS verdes.
- [x] `data/tmp/tts-cache/` no aparece en `git status` (gitignore correcto) y la caché no crece sin límite tras 100 síntesis. → `git status` limpio de caché; LRU 100/50 MB testeado.
- [ ] Review de voz con y sin `OFFLINE_MODE` (edge excluido en offline). *(pendiente — edge no está instalado en este entorno, no reproducible aquí)*

## Fuera de alcance

- Cambiar/migrar de motor TTS (Kokoro, ElevenLabs, etc.) — reevaluar solo si esta feature no alcanza la calidad.
- Emoción/entonación contextual dependiente del LLM (p. ej. entonar pregunta vs afirmación con SSML avanzado) — extensión futura documentable.
- Caché de audio del usuario o de la transcripción.
- Cambiar la voz por fragmento o por rol.

## Recursos

- `src/server.ts` (`/api/tts`, `ttsStatus` — `voices`/`readyVoices`, caché + `X-TTS-Cache`), `src/lib/audio/piper.ts` (`normalizeWav`, `concatWavWithPauses` con pausas por boundary + trailing, `synthesizeSegments`, `isVoiceReady`), `src/lib/audio/edge-tts.ts`, `src/lib/audio/prosody.ts` (re-export tipado) + `public/speech/prosody.js` (partidor canónico), `src/lib/audio/tts-cache.ts` (LRU+TTL), `public/speech/level.js` (gain de cliente edge), `public/ui/practice-view.js` (`speakWithKaraoke`, `buildWordStarts`, `coachVoice`), `public/speech/browser-tts.js`, `public/ui/settings/model-ai.js` (select de voces + hint), `tests/prosody.test.ts`, `tests/tts-cache.test.ts`, `tests/audio-normalize.test.ts`, `tests/level.test.ts`, `spec/use-cases/CU2.md`.
