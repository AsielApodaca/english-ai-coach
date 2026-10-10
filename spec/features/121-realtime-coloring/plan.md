# 121 v2 · Coloreado que sigue al usuario — Plan

## Enfoque

La v1 (fuente de reloj) fue rechazada en prueba manual: avanzaba a velocidad constante. Esta v2 convierte la "opción C" (chunked whisper) del plan original en requisito, bajo el contrato ya existente `LivePositionSource`, y añade el marcado por palabra (dichas + faltantes) derivado del mismo texto parcial.

Invariante central (decisión del usuario): **evaluación y sincronización usan caminos de audio separados.**

- Evaluación = **WAV único completo** del `stop()` → `POST /api/attempt` (camino actual, intacto).
- Sincronización en vivo = **ventanas acumulativas** (`snapshotWav()`: copia del mismo buffer contiguo desde el inicio) → `POST /api/transcribe-partial` → `{ text }` → matcher + pintado.
- Nunca se componen fragmentos de audio ni transcripciones parciales para evaluar; un partial erróneo solo degrada el color provisional.

Por qué acumulativas y no disjuntas: cada ventana contiene el prefijo entero → no hay cortes a media palabra entre ventanas, no hay gaps (mismo stream, snapshots del mismo buffer), y el matcher siempre recibe el texto completo dicho hasta ahora (mismo contrato de "interim" que Web Speech, que también entrega el utterance completo reescrito).

## Contrato: `POST /api/transcribe-partial`

```
Request:  POST /api/transcribe-partial
          Content-Type: audio/wav   (raw body, WAV PCM16 mono 16 kHz, acumulado desde el inicio de la captura)
          ≤ 80mb (express.raw limit, mismo que /api/transcribe)

Response: 200 { "text": string, "durationMs": number }   // durationMs = tiempo del spawn
          400 { "error": string }                         // body vacío / no WAV (isWavBuffer)
          429 { "error": string }                         // ya hay un partial en vuelo (mutex 1)
          503 { "error": string }                         // whisper no disponible / modelo no listo
          500 { "error": string }                         // whisper-cli falló / timeout

Semántica:
- Transcribe CONTEXTO COMPLETO del window (cumulative) — no incremental.
- Máximo 1 partial en vuelo (mutex a nivel de ruta); el cliente además hace 1-en-vuelo.
- Si el cliente se desconecta (req "close" antes de terminar) → child.kill() (libera CPU para el intent final).
- Timeout propio: PARTIAL_TRANSCRIBE_TIMEOUT_MS = 30_000 (const con nombre; NO reutilizar
  SUBPROCESS_TIMEOUT_MS de 60 s que es presupuesto compartido de piper/edge-tts).
- Nunca persiste, nunca toca attempts[], nunca dispara LLM.
```

Registro: en `src/lib/routes/audio.ts` (mismo dominio), JSDoc con el shape exacto arriba del handler (convención del repo). `app.ts` no cambia.

## Implementación

### 1. Servidor — transcripción async (`src/lib/audio/whisper.ts`)

- Reemplazar ambos `spawnSync` por un helper `runWhisper(args, timeoutMs): Promise<{ status, stdout, stderr }>` con `spawn` (patrón `child.on("error")` de `ollama-launch.ts:80-146`), kill en timeout, cierre por `close`. `transcribeWav`/`transcribeWords` quedan async con la **misma** firma/retorno (solo dejan de bloquear el event loop).
- `outPrefix`: `whisper-${randomUUID()}` en ambos (fix de colisión con runs concurrentes; ya se usa `randomUUID` en `attempt.ts:119`/`audio.ts:73`).
- `findBinary()`: memoizar en variable de módulo (hoy hace `execFileSync("which")` ×2 por llamada).
- Tests existentes de parseo (`whisper-words.test.ts`) no cambian; añadir test del prefijo único y del helper async (mock del spawn o tests de integración ligera según patrón existente).

### 2. Servidor — ruta (`src/lib/routes/audio.ts`)

- Handler thin: valida WAV (`isWavBuffer`, hereda la guarda de `/api/transcribe`) → mutex `partialInFlight` (429 si ocupado) → `transcribeWords` (o `transcribeWav`; decide el plan: **`transcribeWav`** — no hacen falta timestamps por palabra, solo el texto) con `PARTIAL_TRANSCRIBE_TIMEOUT_MS` → 200 `{ text, durationMs }`.
- Conexión: registrar listener de `req`/`res` `close` → si la respuesta no se completó, `kill` al hijo (el helper expone el child o acepta un `signal`). Alternativa equivalente: `AbortSignal` desde el handler.
- `finally`: libera el mutex siempre.

### 3. Cliente — `WaveRecorder.snapshotWav()` (`public/speech/recorder-wave.js`)

- Nuevo método: concatena una **copia** de `this.samples` → `encodeWAV(combined, sampleRate)` → Blob. **No** muta `samples`, no hace teardown (a diferencia de `stop()`).
- `discard()`/`stop()` siguen vaciando `samples`; el bombeo de ventanas se invalida al cambiar el estado (la vista aborta y deja de pedir en `settle`/`finally`).
- Test: `tests/recorder-wave.test.ts` — snapshot no muta el array, WAV válido, `stop()` posterior sigue completo.

### 4. Cliente — bombeo de ventanas (`public/ui/practice-view.js`)

Solo fase `full` + ruta `whisper`:

```
MIN_NEW_AUDIO_MS = 750    // audio nuevo mínimo por ventana
MIN_WINDOW_INTERVAL_MS = 1250  // intervalo mínimo entre requests
1 en vuelo                 // si hay fetch pendiente → no enviar
RMS gate                   // rmsDb de los samples nuevos < umbral → no enviar (ahorra CPU en silencio)
```

- Loop con `setInterval` (o chain de timeouts) creado en `createLiveCapturePosition` y **destruido en su `dispose()`**.
- Cada tick: si `recorder.snapshotWav()` tiene ≥ `MIN_NEW_AUDIO_MS` de audio nuevo desde el último envío y RMS ok → `fetch POST /api/transcribe-partial` con `AbortController` (guardado para cancelar en `dispose`/release) → `text` no vacío → `livePosition.feed(text)`.
- **Errores → degradación silenciosa:** cualquier 4xx/5xx/red apaga el bombeo (bandera `disabled`), `console.warn` una vez, sin retry agresivo. **Nunca** lanza hacia `captureAttempt` (el fallback whisper→browser solo lo decide `submitAudio`).
- `cancelPendingTurn` / `finally` → `dispose()` aborta fetch + limpia intervalo.

### 5. Cliente — fuente `streaming` (`public/ui/live-position.js`)

- Borrar: `timeLiveIndex`, `buildCaptureOnsets`, `COACH_MS_PER_WORD`, `LIVE_TICK_MS`, la rama `kind === "time"` del timer, imports de `buildWordStarts`/`splitForTts`.
- `createLivePositionSource({ kind: "interim" | "streaming", targetTokens, register })`: ambas ramas usan `register(handler)` + `advanceLiveIndex` (hoy la rama no-time ya hace esto; renombrar/documentar los kinds). Sin `register` o sin target → degradación (emite nada), como ya ocurre.
- **Nuevo puro `matchLiveWords(targetTokens, text)` → `{ index, spoken: boolean[] }`**: mismo walk greedy que `advanceLiveIndex` (ventana `MAX_MATCH_SKIP`), registrando los targets matcheados. `advanceLiveIndex` pasa a derivar de él (o viceversa — mantener un solo walk, sin duplicar lógica). `spoken[i] = true` solo si el target `i` fue matcheado; por definición, `i > index` nunca están en `spoken`.
- Contrato del consumidor sin cambios: `onWord(index)` sigue emitiendo solo el índice activo (pintado + scroll).

### 6. Cliente — pintado por palabra (`public/ui/practice-view.js` + `public/styles.css`)

- `createLiveCapturePosition.feed(text)` (funnel único: interims del navegador y partials del servidor pasan por aquí):
  1. `matchLiveWords(targetTokens, text)` → `{ index, spoken }`.
  2. rAF coalescido (guard existente): aplicar clases a los spans de `spansForLine(-1)`:
     - `i === index` → `kw-live` (violeta, existente) + `scrollLiveWord(...)` sobre el `.kw-wrap`: la fila de lectura reposa/dispara en el **antepenúltimo renglón visible** (`bookBottom − LIVE_SCROLL_MASK_PX − 2 × altoDeFila` medido del wrap), scroll mínimo con `behavior: "smooth"`; NO usa `scrollIntoView` (esa vía solo puede expresar el padding de la máscara, y `scroll-padding-block` del book también gobierna el scroll de líneas del coach).
     - `spoken[i] && i !== index` → `kw-live-spoken`.
     - `i < index && !spoken[i]` → `kw-live-missing`.
     - resto → quitar clases live.
  3. El source sigue emitiendo `onWord`; para evitar doble pintado, **una sola ruta**: el wrapper consume `matchLiveIndex`/`matchLiveWords` directamente del feed y el `onWord` del source se mantiene solo para el scroll (o el wrapper deja de usar `onWord` y deriva todo del feed — elegir la más simple: feed → states → paint+scroll en un solo frame; `onWord` queda para fuentes que no dan texto, ninguna hoy → simplificar a que el wrapper pinte desde `matchLiveWords` y el source emita `onWord` como hoy para no romper el contrato).
- `styles.css`: `.kw-live-spoken` (verde `#10b981`, sin glow, opacidad ~0.85), `.kw-live-missing` (rojo `#ef4444`, opacidad ~0.85) — distinguibles de los finales `kw-green`/`kw-red` por el tratamiento; documentar fila en `spec/design/design-system.md`.
- `dispose()`: quitar `kw-live`, `kw-live-spoken`, `kw-live-missing` de todo el book (sweep), abortar fetch, limpiar intervalo, `source.stop()`.

### 7. Vista — elección de fuente

- `createLiveCapturePosition(target, stt)`:
  - `stt === "browser"` → kind `interim` (como hoy).
  - `stt === "whisper"` → kind `streaming` + arranca el bombeo de ventanas (§4).
  - Sin recorder/objetivo vacío → `null` (degradación existente).
- `onInterim` de `captureBrowserSpeech` sigue cableado a `feed` (pin existente se mantiene).

### 8. Tests

- `tests/live-position.test.ts`: borrar bloques `timeLiveIndex`/`buildCaptureOnsets`/time-source/degraded-time; añadir `matchLiveWords` (dichas, faltantes, índice, monotonicidad vía feed, techo), kind `streaming`, degradación sin register; mantener `advanceLiveIndex` e interims y los pins de `practice-view.js`.
- Nuevo `tests/transcribe-partial.test.ts` (patrón `tests/app-http.test.ts`): 200 `{text, durationMs}`, 400 WAV inválido, 429 concurrente, 503 sin whisper (inyectar health fake), mutex liberado tras error.
- `tests/recorder-wave.test.ts`: `snapshotWav()` no muta.
- Pin nuevo: `submitAudio` recibe el blob de `stop()` (invariante evaluación=WAV único).
- `npm run check` + `npm test` en verde.

### 9. Docs

- Esta carpeta (spec/plan/tasks) + fila `kw-live-spoken`/`kw-live-missing` en `spec/design/design-system.md` + puntero en `../106-word-timestamps/spec.md` (§ Extensión futura → "streaming parcial implementado en 121 v2") + roadmap (121 vuelve a "En curso" hasta la prueba manual, luego "Hecho ✅").

## Decisiones

- **Acumulativas vs. rolling:** acumulativas — costo de whisper ≤30 s es casi constante (padding del encoder), texto completo para el matcher, cero cortes de palabra. Riesgo aceptado: en capturas largas (>>30 s) cada run crece; el cap 1-en-vuelo + intervalo mínimo lo hace degradarse a updates menos frecuentes, no incorrectos. Alternativa descartada: rolling corta el contexto y hace perder palabras ya dichas (habría que reensamblar texto en el cliente con solapamientos).
- **`transcribeWav` (solo texto) para partials:** los timestamps por palabra no se usan en vivo (la posición la da el matcher contra el target); `transcribeWords` queda para `/api/attempt` como hoy.
- **Respuesta directa por ventana (no long-poll 116):** el cliente marca el ritmo; sin ids/TTL/caps de 20 s. Long-poll solo serviría si el servidor transcribiera más rápido que el cliente — no es el caso.
- **Texto desde el servidor, alineación en el cliente:** el endpoint es genérico (sin `target`), reutiliza `matchLiveWords`/`advanceLiveIndex` ya testeados, y el target no viaja en cada ventana. Descartado: devolver `AlignedWord[]` (acopla el endpoint al target y cambia su semántica por request).
- **Mutex 1-en-vuelo en servidor + 1-en-vuelo en cliente:** doble defensa contra disparo de CPU; el cliente es el que pacea, el servidor solo evita el caso bug.
- **Kill en desconexión:** al soltar PTT el cliente aborta; el servidor mata el hijo para que el `/api/attempt` final no compita con una ventana huérfana.
- **Silencio se filtra en cliente (RMS):** más barato que transcribir y descartar `[BLANK_AUDIO]`; el server igual tolera silencio (`isBlankTranscript`).
- **`spawn` async en shared `transcribeWav/Words`:** mejora también el camino actual de `/api/attempt` (116 deja de esperar bloqueos); alternativa descartada: duplicar funciones async al lado de las sync (dos cadenas que divergen).
- **Sin ámbar en vivo:** el ámbar de pronunciación/LLM solo existe post-hoc; pintar ámbar provisorio generaría falsos "casi bien". Verde/rojo provisorios sí, marcados como live (clases propias) hasta el semáforo definitivo.
- **Eliminar `time` en vez de fallback:** decisión del usuario — avance fantasma peor que ausencia de avance.

## Riesgos

- **Latencia por ventana (recarga de modelo + inferencia ~0.5–3 s, 1 en vuelo):** el seguimiento va con lag respecto al habla; aceptado (mejor lag que ritmo fijo). Mitigación futura documentada: whisper persistente/servidor.
- **Falsos positivos de partials (whisper inventa con poco contexto):** mitigado por monotonicidad + `MAX_MATCH_SKIP` + los estados live son provisorios y se barren al evaluar.
- **CPU total durante captura:** 1 partial en vuelo + gate RMS + intervalo mínimo; al soltar, kill del hijo. Si el equipo no da abasto, la degradación es natural (ventanas más espaciadas por el propio cap).
- **Colisión de prefijos / bloqueo de event loop** — resueltos en esta feature (uuid + async).
- **Regresión del camino de evaluación:** no se toca `submitAudio`/`/api/attempt`; pin de test lo protege.
- **Doble fuente de estado hablado (`kw-live*` vs `kw-spoken` del coach):** la fase `full` espera la lectura; verificación manual (riesgo ya registrado en v1).
