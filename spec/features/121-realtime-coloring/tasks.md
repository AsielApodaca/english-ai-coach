# 121 v2 · Coloreado que sigue al usuario — Tasks

Orden recomendado (servidor → módulo puro → cliente → integración → docs):

## Servidor

- [x] `src/lib/audio/whisper.ts`: migrar `transcribeWav`/`transcribeWords` de `spawnSync` a `spawn` async (helper con kill en timeout, misma firma/retorno); `outPrefix` con `randomUUID()`; `findBinary()` memoizado.
- [x] `src/lib/routes/audio.ts`: `POST /api/transcribe-partial` (WAV crudo acumulado → `{ text, durationMs }`; 400 WAV inválido, 429 mutex 1-en-vuelo, 503 sin whisper, 500 fallo; `PARTIAL_TRANSCRIBE_TIMEOUT_MS = 30_000`; kill del hijo si el cliente se desconecta; mutex liberado en `finally`).
- [x] Tests: `tests/transcribe-partial.test.ts` (patrón `app-http`: 200/400/429/503 + mutex liberado + kill al desconectar); test de outPrefix único y del helper async en `tests/whisper-spawn.test.ts` (fake `whisper-cli` de `tests/fake-whisper.ts`).

## Módulo puro (`public/ui/live-position.js`)

- [x] Eliminar la fuente `time`: `timeLiveIndex`, `buildCaptureOnsets`, `COACH_MS_PER_WORD`, `LIVE_TICK_MS`, rama de timer, imports de `buildWordStarts`/`splitForTts`.
- [x] Nuevo puro `matchLiveWords(targetTokens, text)` → `{ index, spoken: boolean[] }` (un solo walk greedy, ventana `MAX_MATCH_SKIP`); `advanceLiveIndex` derivado del mismo walk.
- [x] Kinds documentados: `"interim"` | `"streaming"` (ambos vía `register`); degradación sin register/target = emitir nada.
- [x] Tests (`tests/live-position.test.ts`): añadir `matchLiveWords` (dichas, faltantes, índice activo, monotonicidad, techo) y kind `streaming`; borrar tests de `time*`; mantener interims y pins de `practice-view.js`.

## Cliente — audio

- [x] `public/speech/recorder-wave.js`: `snapshotWav()` (copia de `samples` → WAV, sin mutar, sin teardown) + test en `tests/recorder-wave.test.ts`.

## Cliente — vista (`public/ui/practice-view.js`)

- [x] `createLiveCapturePosition`: ruta `streaming` (whisper) con bombeo de ventanas (`MIN_NEW_AUDIO_MS=750`, `MIN_WINDOW_INTERVAL_MS=1250`, 1 en vuelo, gate RMS, `AbortController`); ruta `interim` intacta; errores de partial → apagar bombeo con un `console.warn`, nunca throw (no disparar fallback whisper→browser).
- [x] Feed único → `matchLiveWords` → pintado por palabra en rAF: `kw-live` (activa + scroll sobre `.kw-wrap`), `kw-live-spoken` (dichas), `kw-live-missing` (faltantes antes de la posición); monotonicidad y reset por captura.
- [x] `dispose()`: abortar fetch, limpiar intervalo, sweep de las tres clases live sobre todo el book, `source.stop()`; en `finally` de `captureAttempt` (cubrir también `cancelPendingTurn`).
- [x] Pin: `submitAudio` recibe el blob de `stop()` — la evaluación jamás usa snapshots de ventanas.
- [x] Ajuste del umbral de auto-scroll (feedback manual): `scrollLiveWord(wrap)` reemplaza al `scrollIntoView` del paint — la fila de lectura se mantiene en el **antepenúltimo renglón visible** (colchón de `LIVE_SCROLL_KEPT_ROWS = 2` filas bajo la lectura, `LIVE_SCROLL_MASK_PX = 48` de máscara), alto de fila medido del wrap (IPA on/off) y disparo solo al salir de la línea de reposo.

## Estilos / design system

- [x] `public/styles.css`: `.kw-live-spoken` (verde sin glow, opacidad ~0.85) y `.kw-live-missing` (rojo, opacidad ~0.85) — distinguibles de `kw-green`/`kw-red` finales.
- [x] `spec/design/design-system.md`: filas nuevas en paleta/estados de palabra.

## Revisión (FASE 6)

- [x] Fix (mutex leak): `mkdirSync`/`writeFileSync` de `POST /api/transcribe-partial` movidos dentro del `try` — un fallo de disco saltaba por encima del `finally` y dejaba el mutex pegado (429 permanente hasta reiniciar). Test regresión: `tests/transcribe-partial.test.ts` (fallo de escritura → 500 y la siguiente ventana → 200).
- [x] Fix (mismo invariant): `rmSync` del `finally` hecho best-effort — `force` solo suprime `ENOENT`; si `data/tmp` está roto (un archivo regular en su sitio) saltaba `ENOTDIR` y **antes** de `partialInFlight = false`.
- [x] Fix (flake): test de abort de `tests/whisper-spawn.test.ts` endurecido con handshake de arranque del hijo (espera el log de arranque del fake antes de abortar); un SIGTERM durante el boot del hijo bajo carga paralela no escribía el marker.
- [x] Decisión (menor, sin cambio): la vista pinta con `matchLiveWords` directo y no usa `LivePositionSource.onWord`; se mantiene el source porque la vista sí depende de su ciclo `start()`/`register` (gate del sink) y el contrato `onWord` está pinneado por tests.

## Verificación

- [x] `npm run check` y `npm test` en verde.
- [ ] Manual: respuesta larga → pintado/scroll siguen el habla real (pausa → se detiene; habla rápido → avanza); al soltar, semáforo 106/116 normal y sin clases live residuales.
- [ ] Manual sin señal (endpoint caído / sin whisper): flujo pre-121, sin errores en consola ni avance fantasma.
- [ ] Manual de responsividad: TTS y `/api/attempt` responsivos durante ventanas rodantes (event loop no bloqueado).
- [ ] Regresión: popover 112, click 113, refinado 116, guard de teclado del área, PTT con auto-repeat.

## Docs

- [x] Actualizar esta carpeta (estado del spec), puntero en `../106-word-timestamps/spec.md` (§ Extensión futura → streaming parcial implementado en 121 v2) y design-system. Roadmap pendiente hasta la verificación manual.
