# 111 · Captura manual push-to-talk (botón / tecla espacio)

**Estado:** done ✅ (implementado, review aprobado; checklist manual pre-merge pendiente de verificación en browser)

## Contexto

- Caso de uso: CU2, pasos 9–10 (usuario repite el fragmento; el sistema escucha) y 16 (respuesta completa) (`../../use-cases/CU2.md`).
- Pantallas: dock de audio / orb de estado (`../../design/design-system.md`; `../../design/screens.md` §2).
- Base:
  - `public/ui/practice-view.js` — `waitForUserRecording()` (turno hands-free: beep → graba → VAD decide el corte), constantes `SPEECH_DB`/`SILENCE_MS`/`GUARD_TIMEOUT_MS`/`MAX_TURN_MS`, `captureAttempt()` y `captureBrowserSpeech()`.
  - `public/speech/vad.js` — `VadTracker` (VAD por energía, umbral fijo −55 dBFS / 1200 ms).
  - `public/speech/recorder-wave.js` — `WaveRecorder` (ScriptProcessor 16 kHz, `getUserMedia` sin constraints explícitos).
- Problema de origen (issue #2): el fin de turno depende de detectar silencio; con ruido de fondo continuo (abanico) los frames nunca bajan del umbral → **la captura no se corta** y el turno termina (si acaso) por el guard de 60 s con audio basura.
- Decisiones registradas (sesión de especificación):
  - **Re-enfoque:** la feature implementa **push-to-talk (PTT)**; el fin de turno por silencio se **retira**. El bug del abanico desaparece por diseño: el turno termina cuando el usuario suelta.
  - Guards: **espera infinita** para iniciar + techo de captura de **3 s por palabra** del objetivo.
  - Señalización **solo visual**, sin beep.

## Qué hace

Elimina el apagado/encendido automático del micrófono. Cuando el coach termina de leer el fragmento, el sistema **espera indefinidamente** a que el usuario inicie la captura **manteniendo presionado** el botón de micrófono (pointer) o la **tecla espacio**; al **soltar**, la captura se corta y se evalúa el audio. Mientras el usuario mantiene presionado, el micrófono se **resalta visualmente** para distinguir claramente "grabando" de "esperando". El VAD ya no decide el corte de turno.

## Por qué

- **Fix del issue #2:** con corte manual, el ruido de fondo ya no impide terminar el turno (el abanico dejó de ser un problema de detección de silencio).
- **Control del usuario:** decide cuándo empieza y termina su turno; no hay cortes prematuros por pausas naturales ni colgados por ruido.
- **Aprovecha la interacción:** durante la espera (coach no hablando, no grabando) las palabras del karaoke quedan disponibles para hover/click (features 112/113); durante la grabación, no.

## Requerimientos funcionales

- [x] **Inicio manual:** el micrófono **nunca** arranca solo. Dos disparadores equivalentes:
  - Pointer: `pointerdown` (o `mousedown`) sobre el botón de micrófono del dock → inicia; `pointerup`/`pointercancel`/`pointerleave` → corta.
  - Teclado: `keydown` de la tecla espacio (con guard anti-`repeat`: solo el primer keydown cuenta) → inicia; `keyup` → corta. `preventDefault()` en espacio para no scrollear ni activar botones con foco. Ignorar la tecla cuando el foco esté en un input/textarea/contenteditable.
- [x] **Corte al soltar:** soltar el botón/tecla finaliza la captura inmediatamente y dispara la evaluación del audio capturado (`captureAttempt` con el WAV) — sin esperar silencio ni pasar por `VadTracker`.
- [x] **Techo de captura = 3 s por palabra:** `maxCaptureMs = 3000 × wordCount(objetivo)` (fragmento actual en modo fragmento; respuesta completa en modo full). Al alcanzar el techo, la captura se corta **automáticamente** y se evalúa lo capturado (equivale a "soltar"). Se documenta que en respuesta completa el techo es 3000 × palabras del full answer (p. ej. 100 palabras → 300 s).
- [x] **Mínimo anti-tap accidental:** un `pointerdown`/`keydown` más corto que ~200 ms que no produzca audio utilizable no dispara evaluación: se descarta como pulsación accidentada y el turno sigue esperando (sin penalización, sin locución de no-speech). Definir `MIN_PRESS_MS = 200` como constante testeable.
- [x] **Espera infinita:** se **elimina** el guard de 20 s sin voz (`GUARD_TIMEOUT_MS`) — el sistema espera el tiempo que haga falta a que el usuario pulse. El orb/panel indica el turno en espera (ver abajo).
- [x] **Estados visuales distintos** (requisito explícito del usuario):
  - *Esperando turno:* micrófono y orb en estado reposo/"tu turno" (indicación de que debe mantener presionado espacio/botón).
  - *Grabando (presionado):* micrófono **resaltado** de forma claramente diferenciada (color de acento/borde/glow + estado activo del orb "Escuchando…" con waveform), que sea evidente la diferencia respecto a reposo.
  - *Coach hablando:* estado actual de lectura (sin resaltado de micrófono).
- [x] **Sin beep:** se **elimina** `playBeep()` y `BEEP_READY_MS` del flujo de turno. La señal de inicio de turno es exclusivamente visual.
- [x] **VAD retirado del corte:** `waitForUserRecording` deja de construir `VadTracker` ni de reaccionar a `feed(db)` para terminar el turno. `public/speech/vad.js` se marca como código no usado por el flujo principal (mantener el archivo y sus tests como legacy documentado **o** eliminarlo en esta misma feature — decisión de implementación a registrar en el PR; ver Decisiones).
- [x] **VU/medidor:** el nivel dB del dock sigue mostrándose durante la grabación (feedback mientras presiona). Con ruido de fondo puede marcar alto — aceptable, es informativo.
- [x] **Modo fallback BrowserSTT:** `captureBrowserSpeech` se inicia al presionar y se detiene al soltar (`recognition.stop()`), conservando el manejo existente de `onend`/errores. Sin arranque automático.
- [x] **Ruido de fondo → transcripción:** se fijan constraints explícitas en `getUserMedia`: `{ audio: { noiseSuppression: true, echoCancellation: true, autoGainControl: true, channelCount: 1 } }` (hoy dependen de defaults del browser) para que la grabación con abanico ruidoso se limpie antes de llegar a whisper.
- [x] **Reentrada/seguridad:** si ya hay una captura activa, un nuevo `pointerdown`/`keydown` no crea una segunda captura concurrente; si el flujo se cancela (`cancelFlow`) con la captura activa, se corta la captura, se descarta el audio y no se evalúa.
- [x] **Concurrencia teclado+botón:** mantener presionado el espacio y también el botón (o viceversa) no duplica la captura; el corte ocurre cuando **ambos** soltaron (o al primer `keyup` — elegir el más simple y testearlo; recomendación: contar presses, cortar a 0).

## Requerimientos no funcionales

- Latencia de inicio de captura tras `pointerdown`/`keydown`: precalentar el `AudioContext`/`WaveRecorder` al entrar en la fase de espera (reutilizar el `prewarm()` actual) para que el primer frame no se pierda.
- Cero dependencias npm nuevas; cero llamadas de red para el mecanismo de captura.
- El WAV capturado mantiene el formato actual (16 kHz mono PCM16) — sin cambios en `encodeWAV`.

## Decisiones de diseño / tecnología

- **PTT en vez de VAD adaptativo** (decisión del usuario): ataca la causa raíz del issue #2 (corte automático ante ruido) eliminándolo. Alternativa descartada: suelo de ruido adaptativo (percentil + margen) — queda documentada como camino no elegido por si se reintenta un modo automático configurable en el futuro; **no** se implementa en esta feature.
- **`vad.js` — decisión final: ELIMINADO.** Se borraron `public/speech/vad.js` y `tests/vad.test.ts` en esta misma feature (no quedan como legacy): el flujo principal ya no tiene ningún camino automático de corte, mantenerlo sería código muerto. Si en el futuro vuelve un modo auto configurable, hay que reescribirlo (era 52 líneas, sin dependencias). La lógica de turno vive ahora en `public/speech/ptt.js` (máquina de estados pura, con reloj inyectado), cubierta por `tests/ptt.test.ts`.
- **Techo por palabra (3 s/palabra):** regla lineal simple, acotada por la longitud del objetivo; reemplaza al `MAX_TURN_MS = 60_000` fijo (que era corto para full answer y largo para fragmentos de 5 palabras).
- **Espacio como disparador:** es el atajo universal de push-to-talk; `preventDefault` con guard de foco en inputs para no romper la edición de texto en settings/perfil.
- **Feedback visual en lugar de beep:** un solo canal de señal (visual) elimina el sonido intrusivo y la espera del `BEEP_READY_MS`.
- **Concurrencia:** conteo de presses por fuente (`"pointer"` / `"space"`); arranque en 0 → 1 y corte en 1 → 0 (la opción recomendada por este spec, testearla).

## Dependencias

- 105 (loop de fases; consume `waitForUserRecording`).
- 112/113 (interacción con palabras): este spec define **cuándo** están habilitadas (no grabando y coach no hablando) — ver notas de cruce abajo.
- 002 (whisper) y fallback browser STT: consumidores del audio capturado, sin cambios de contrato.

## Criterios de aceptación

- [x] Unit tests nuevos en `tests/ptt.test.ts` (o ampliación de `tests/vad.test.ts` si se conserva): `maxCaptureMs(fragmento)` = 3000 × palabras; `MIN_PRESS_MS`; máquina de estados del press (idle → recording → released → evaluate; tap accidental no evalúa; techo alcanzado ⇒ auto-release y evaluate; doble press no concurre).
- [x] `npm test` en verde (los tests antiguos de `VadTracker` siguen pasando si se conserva el archivo) y `npm run check` verde con los ficheros nuevos agregados.
- [ ] Prueba manual con ruido de fondo (abanico o audio de ruido): tras leer el fragmento, el turno **espera** (no corta ni se colga); el usuario presiona → graba; suelta → se evalúa **siempre** en < 300 ms tras el `keyup`.
- [ ] Prueba manual de techo: mantener presionado más de 3 s × palabras del fragmento → la captura corta sola y evalúa.

## Checklist de verificación (pre-merge)

- [ ] El micrófono **no** se enciende solo en ningún punto del flujo (inicio de pregunta, reintento, respuesta completa, reanudación de sesión, siguiente pregunta).
- [ ] Botón de micrófono y tecla espacio funcionan de forma intercambiable (probar ambos en: primer fragmento, reintento, full answer).
- [ ] Espacio no scrollea la página ni activa botones con foco; no dispara con teclas repetidas (`keydown` repeat); no dispara mientras el cursor está en un input de settings/perfil.
- [ ] Diferencia visual "esperando" vs "grabando" evidente (revisar contraste según `design-system.md`, estados del orb y del botón de mic).
- [ ] No queda ningún beep en el flujo de turno (`grep -rn "playBeep\|BEEP_READY" public/` sin resultados activos).
- [ ] Guard de 20 s eliminado: dejar 2 minutos sin presionar → el turno sigue esperando, sin abortar.
- [ ] Techo 3 s/palabra: verificar cálculo con fragmento de 6 palabras (18 s) y con full answer.
- [ ] Cancelar la sesión con la captura activa → se corta la grabación, no aparece feedback/evaluación, sin audio fantasma persistido.
- [ ] Fallback sin whisper (BrowserSTT): presionar/soltar inicia y detiene `speechRecognition` correctamente.
- [ ] Transcripción con ruido de fondo: comprobar que `noiseSuppression` activo mejora (o al menos no empeora) la transcripción vs antes.
- [ ] Sin regresión en el coloreado: el audio evaluado produce `words[]`/colores igual que con el flujo anterior (106/105).
- [ ] Interacción cruzada con 112/113: durante la grabación, hover/click en palabras **no** tiene efecto; en la espera, sí.

## Fuera de alcance

- VAD adaptativo / suelo de ruido / Silero (caminos documentados, no elegidos).
- Cambios en whisper ni en `/api/attempt` (contrato de evaluación intacto).
- Grabación múltiple por turno, edición de audio, VAD visual de "voz detectada".
- Rediseño del dock de audio (solo estados del micrófono y orb).

## Recursos

- `public/ui/practice-view.js` (`waitForUserRecording`, `captureAttempt`, `captureBrowserSpeech`, triggers de teclado), `public/speech/ptt.js` (máquina de estados PTT + `maxCaptureMs`/`MIN_PRESS_MS`), `public/speech/recorder-wave.js`, `public/ui/audio-dock.js`, `public/styles.css` (estados del dock/orb), `tests/ptt.test.ts`, `spec/use-cases/CU2.md`.
