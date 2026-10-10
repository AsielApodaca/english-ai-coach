# 121 · Coloreado en tiempo real que sigue al usuario + auto-scroll de la respuesta modelo

**Estado:** v2 implementada y revisada ✅ (pendiente verificación manual — la v1 con fuente de reloj fue implementada y rechazada en prueba manual; la v2 sigue el habla real)

## Contexto

- Caso de uso: CU2 (fase de respuesta entera; el usuario repite la respuesta modelo completa).
- Pantallas: karaoke (`../../design/screens.md` §2 y design-system § componente 1).
- Origen: ítem de backlog del roadmap y "Extensión futura" de `../106-word-timestamps/spec.md` (streaming de timestamps + alineador incremental + render por palabra).
- **Historial de la v1 (rechazada):** la primera implementación usó la fuente A "agenda temporal del coach" (velocidad constante `COACH_MS_PER_WORD = 350`): el coloreado avanzaba a ritmo fijo, independiente de lo que el usuario realmente decía. Prueba manual del usuario: *"el coloreado va avanzando con una velocidad constante totalmente independiente a lo que realmente va diciendo el usuario"* → **rechazada**. Decisión registrada: la posición en vivo debe derivarse del habla real del usuario.
- Base actual (v2 implementada):
  - `public/ui/live-position.js` — contrato `{ start(), stop(), onWord(cb) }` con kinds `interim` y `streaming` (ambos vía `register(handler)`); matcher greedy monotónico `advanceLiveIndex` derivado del puro `matchLiveWords` (índice activo + máscara `spoken[]`). La fuente `time` fue eliminada.
  - `public/ui/practice-view.js` — `createLiveCapturePosition()` elige kind por ruta STT; en ruta whisper arranca el bombeo de ventanas acumulativas (`createWindowPump`: `MIN_NEW_AUDIO_MS`/`MIN_WINDOW_INTERVAL_MS`/1 en vuelo/gate RMS, abort en release) contra `POST /api/transcribe-partial`; pintado `kw-live`/`kw-live-spoken`/`kw-live-missing` + scroll con guard rAF; cleanup en `finally` de `captureAttempt`.
  - `public/speech/recorder-wave.js` — `WaveRecorder` (ScriptProcessor 2048 frames @16 kHz), `samples` append-only, `snapshotWav()` (ventana = copia, sin mutar) y `stop()` → WAV completo de evaluación.
  - `src/lib/audio/whisper.ts` — `transcribeWav`/`transcribeWords` con **`spawn` async** (kill en timeout/desconexión, `outPrefix = whisper-${randomUUID()}`, `findBinary()` memoizado).
  - `src/lib/routes/audio.ts` — `POST /api/transcribe-partial` (mutex 1-en-vuelo, `PARTIAL_TRANSCRIBE_TIMEOUT_MS = 30_000`, kill del hijo al desconectar).
  - `public/speech/browser-stt.js:42` — hook `onInterim` ya consumido por la ruta navegador.
- Problema persistente de la v1: en fase `full` la respuesta es **una sola línea** de 40px en un contenedor de 46vh con barra oculta; durante la captura SPACE está bloqueado por PTT → el usuario no puede scrollear a mano. El auto-scroll en vivo es la solución; ahora debe seguir la posición **real** del usuario.

## Qué hace

Motor de posición en vivo que **sigue al usuario**, no al revés:

1. **Fuente híbrida de habla real** bajo el contrato único `LivePositionSource`:
   - **Ruta whisper (por defecto):** durante la captura `full`, el cliente envía **ventanas acumulativas** de audio (copia del buffer desde el inicio de la captura) a `POST /api/transcribe-partial`; la respuesta `{ text }` alimenta el matcher de posición. El servidor transcribe con whisper en **spawn async**.
   - **Ruta navegador:** interinos de Web Speech (`onInterim`), ya existentes.
   - La fuente de reloj (velocidad constante) **se elimina**; sin señal de habla real → sin posición en vivo (degradación), nunca avance a ritmo fijo.
2. **Marcado en vivo por palabra** (evaluación híbrida, capa provisional):
   - `kw-live` — palabra activa (donde va la lectura del usuario) + auto-scroll con guard rAF (`scrollLiveWord` sobre el wrap): la fila de lectura se mantiene en el **antepenúltimo renglón visible** del book — la línea de reposo es `bookBottom − 48px (máscara) − 2 × altoDeFila` (alto medido del wrap, se adapta al IPA on/off) — y solo dispara cuando la fila activa sale de esa línea (≈ 1 scroll por renglón avanzado).
   - `kw-live-spoken` (verde provisional) — palabras que el matcher confirma ya dichas.
   - `kw-live-missing` (rojo provisional) — palabras objetivo anteriores a la posición que el usuario **no** dijo.
   - Al soltar: cleanup total de clases live; el semáforo **definitivo** (green/amber/red con pronunciación/LLM, 106+116) pinta sobre lienzo limpio. Nada de estado live entra en `attempts[].words`.
3. **Separación dura evaluación vs. sincronización** (decisión explícita del usuario):
   - La **evaluación** usa siempre el WAV **único y completo** del `stop()` → `POST /api/attempt` → `transcribeWords` (camino existente, intacto).
   - Las **ventanas** son copias `snapshotWav()` del mismo buffer contiguo (acumulativas, sin cortes ni gaps entre ventanas) y alimentan **solo** el pintado/scroll en vivo; jamás componen la transcripción de evaluación. Un partial erróneo solo degrada el color provisional.

## Por qué

- **El sistema debe seguir al usuario:** colorear a ritmo fijo es engañoso; la posición solo es meaningful si nace de lo que el usuario dice en ese momento.
- **Scroll imposible durante captura:** barra oculta + SPACE bloqueado por PTT = texto desbordado inaccesible en el momento en que más se necesita.
- **Feedback inmediato palabra por palabra:** ver avance real + faltantes en vivo da la sensación de karaoke evaluando sobre la marcha.
- **Sin riesgo de palabras cortadas en la evaluación:** la evaluación nunca se compone de ventanas; es el WAV completo de siempre.
- **`spawnSync` es insostenible con ventanas:** bloquearía el event loop (TTS, health, long-poll 116) durante cada ventana; la migración a `spawn` async es prerequisito y además mejora el camino actual.

## Requerimientos funcionales

- [x] **Fuente de posición = habla real** — contrato único `LivePositionSource` con dos implementaciones: `interim` (Web Speech) y `streaming` (texto parcial del servidor). El kind `time` y todo su aparato (`timeLiveIndex`, `buildCaptureOnsets`, `COACH_MS_PER_WORD`, `LIVE_TICK_MS`) se **elimina**.
- [x] **Endpoint de partials** — `POST /api/transcribe-partial` (WAV crudo acumulado) → `{ text, durationMs }`. Contrato documentado en `plan.md` y en el JSDoc de la ruta. Máximo 1 partial en vuelo (429 si ocupado); el hijo whisper se **killed** si el cliente se desconecta; timeout propio (no el de 60 s de piper/edge-tts).
- [x] **Transcripción async** — `transcribeWav`/`transcribeWords` migran de `spawnSync` a `spawn` async sin cambiar su contrato de retorno; `outPrefix` pasa a `randomUUID()` (fix de colisión); `findBinary()` cacheado. El camino de `/api/attempt` sigue funcionando idéntico, ahora sin bloquear el event loop.
- [x] **Ventanas del cliente** — `WaveRecorder.snapshotWav()` (copia del buffer, sin mutar `samples`); cadencia con mínimo de audio nuevo (~750 ms) e intervalo mínimo (~1.25 s), 1 en vuelo; gate por RMS (no enviar silencio); solo fase `full` en ruta whisper.
- [x] **Marcado en vivo por palabra** — `matchLiveWords(targetTokens, text)` (puro, mismo walk greedy que `advanceLiveIndex`) devuelve índice activo + máscara de dichas; la vista pinta `kw-live` / `kw-live-spoken` / `kw-live-missing` con guard rAF y hace auto-scroll sobre el wrap de la palabra activa que mantiene la fila de lectura en el **antepenúltimo renglón visible** (colchón de 2 filas bajo la lectura; `scrollLiveWord`, no `scrollIntoView`).
- [x] **Monotonicidad** — la posición solo avanza durante una captura; reset al iniciar cada captura y al evaluar.
- [x] **Degradación** — sin señal de habla real (endpoint caído, modelo no listo, primer 4xx/5xx, ruta sin interinos): fase `full` funciona como antes de la feature, **sin** pintado/scroll en vivo y sin errores en consola; en ningún caso los fallos de partial disparan el fallback whisper→browser (eso lo decide solo `submitAudio`) ni bloquean la captura.
- [x] **Precedencia post-hoc** — al llegar `words[]` de `/api/attempt`, `colorWords()` pinta el semáforo definitivo sobre lienzo limpio (clases live barridas en el `finally`); guard de refinado (`attemptId` + `flowToken`, 116) intacto.
- [x] **Cleanup garantizado** — en todos los caminos de salida de `captureAttempt` (éxito, fallo, excepción, soltar PTT, `cancelPendingTurn`): quitar clases live, abortar fetch de partial en vuelo, detener el bombeo de ventanas, sin estado vivo colgando.
- [x] **Evaluación = WAV único** — la evaluación post-hoc usa exclusivamente el WAV completo de `stop()`; las ventanas nunca se concatenan ni componen la transcripción de evaluación (invariante documentado y testeado).

## Requerimientos no funcionales

- Latencia del pintado/scroll: percepción de seguimiento real; el budget real lo pone la inferencia local (~0.5–3 s por ventana con `small.en`, 1 en vuelo) — aceptado y documentado; el scroll/repaint sigue siendo < ~100 ms desde la señal (rAF).
- Presupuesto $0: sin dependencias npm nuevas (sin WS/SSE: respuesta directa por ventana, paced por el cliente).
- Sin cambios de contrato en `/api/attempt`, `/api/transcribe`, `attempts[]` ni la forma de sesión. El único contrato nuevo es `/api/transcribe-partial` (documentado en el mismo cambio).
- Migración async sin regresión: los tests existentes de whisper/attempt deben seguir verdes.
- Frontend vanilla; módulos < ~300 líneas; TS estricto.

## Decisiones de diseño / tecnología

- **Ventanas acumulativas, no fragmentos disjuntos:** cada ventana es el prefijo completo desde el inicio de la captura → no hay cortes a media palabra entre ventanas ni gaps (es el mismo buffer contiguo). Justificación y comparación en `plan.md`.
- **Evaluación y sincronización viven en caminos separados** (decisión del usuario): partials → solo posición/coloreado provisorio; WAV completo → evaluación definitiva. Un partial erróneo nunca contamina el score.
- **Ámbar solo post-hoc:** el ámbar por pronunciación/LLM (`forcedAmberWordsFromIssues`) requiere el resultado completo; en vivo no se emite ámbar (el aligner determinista de `/api/attempt` sigue emitiendo su ámbar de desviación como hoy).
- **Sin señal → sin vivo:** se elimina el reloj en vez de degradar a él (decisión explícita del usuario: un avance constante es peor que no tener avance).
- **Fase `full` es el único consumidor** (motivación del bug del scroll); el bucle de fragmentos queda fuera de alcance.

## Dependencias

- 106 (word timestamps + `alignWords`) y 116 (pintado incremental post-hoc) — se consumen, no se modifican.
- 111 (push-to-talk) — convive: el bombeo de ventanas vive dentro de la captura; cleanup al soltar. El fix del auto-repeat de SPACE (prevención de scroll) forma parte de esta v2.
- 112/113 (popover/click) — se respeta `canInteractWithWords()`; el scroll/pintado en vivo no habilita interacción.
- 105 (vista karaoke: `rebuildBook`, `colorWords`, `spansForLine`).
- 002 (whisper local) — cadena `transcribeWav`/`transcribeWords` migrada a async.

## Criterios de aceptación

- [x] Tests del módulo puro (`tests/live-position.test.ts`): `matchLiveWords` (dichas + faltantes + índice activo), monotonicidad, techo, degradación sin señal, fuente `streaming`; tests de `time` eliminados.
- [x] Tests del contrato `POST /api/transcribe-partial` (patrón `app-http`): 200 con texto, 400 WAV inválido, 429 con partial en vuelo, 503 sin whisper; kill del hijo al desconectar.
- [x] Tests de `snapshotWav()` (no muta `samples`) y de la migración async de whisper (outPrefix único por run).
- [x] Pin de invariante: la vista llama a `submitAudio` con el blob de `stop()`, nunca con snapshots de ventanas.
- [x] `npm run check` y `npm test` en verde.
- [ ] Prueba manual: respuesta modelo larga → el pintado/scroll avanza **con el habla del usuario** (pausa el usuario → se detiene; habla rápido → avanza); la fila de lectura se queda en el **antepenúltimo renglón visible** (2 filas de colchón debajo, no en el borde inferior); al soltar, semáforo normal.
- [ ] Prueba manual sin señal (endpoint caído / ruta sin interinos): flujo idéntico al pre-121, sin errores en consola ni scroll espurio ni avance fantasma.
- [ ] Prueba manual: `/api/attempt` y TTS siguen responsivos durante una captura con ventanas rodantes (el event loop no se bloquea).
- [ ] Regresión: popover (112), click (113), refinado amber (116) y guard de teclado del área operativos.

## Fuera de alcance

- Cambiar `/api/attempt`, `alignWords`, `attempts[].words` o la persistencia.
- Emitir ámbar (pronunciación) en vivo.
- Servidor whisper persistente / modo streaming de whisper.cpp (evolución futura si la latencia por run es inaceptable).
- WebSocket/SSE.
- Bucle de fragmentos (líneas cortas, ya con `setCurrentLine`).
- Evaluar (score/LLM) mientras se habla.

## Recursos

- `public/ui/live-position.js`, `public/ui/practice-view.js`, `public/speech/recorder-wave.js`, `public/speech/browser-stt.js`, `public/styles.css`.
- `src/lib/audio/whisper.ts`, `src/lib/routes/audio.ts`, `src/lib/util/subprocess.ts`.
- `spec/features/106-word-timestamps/spec.md`, `spec/features/116-fast-fragment-eval/spec.md`, `spec/use-cases/CU2.md`, `spec/design/design-system.md`.
