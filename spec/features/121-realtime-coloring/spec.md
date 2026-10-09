# 121 · Coloreado en tiempo real exacto + auto-scroll de la respuesta modelo

**Estado:** especificada 📝 (pendiente de implementar)

## Contexto

- Caso de uso: CU2 (fase de respuesta entera; el usuario repite la respuesta modelo completa).
- Pantallas: karaoke (`../../design/screens.md` §2 y design-system § componente 1).
- Origen: ítem de backlog del roadmap y "Extensión futura" de `../106-word-timestamps/spec.md` (línea 56: *"streaming de timestamps … + alineador incremental por ventana + render por palabra"*).
- Base:
  - `public/ui/practice-view.js` — `rebuildBook()` rama `isFull` (línea 1545, **sin** `setCurrentLine` → sin auto-scroll), `colorWords()` (1629, solo post-hoc), `captureAttempt()` (1022, fetch bloqueante hasta soltar).
  - `public/styles.css:1893` — `.karaoke-book` con `max-height: 46vh`, `overflow-y: auto` y **barra de scroll oculta** (`scrollbar-width: none`), máscara CSS gradiente.
  - `public/speech/browser-stt.js:42` — hook `onInterim` declarado (`interimResults: true`) y **sin consumir** (la vista lo descarta).
  - `src/lib/practice/align-words.ts:178` — `alignWords()` es **batch**: LCS global sobre el transcript completo con timestamps, no incremental.
- Problema: en la fase `full` la respuesta entera es **una sola línea** de 40px dentro de un contenedor de 46vh con barra oculta; si desborda, el texto queda oculto y el único scroll existente (`setCurrentLine → scrollIntoView`, `practice-view.js:1590`) no se invoca en esa rama. Durante la captura, además, SPACE está bloqueado por push-to-talk (`practice-view.js:277-285`) → **el usuario no puede hacer scroll mientras graba**.
- Decisión registrada en 106: el coloreado green/amber/red es post-grabación; esta feature es la extensión de tiempo real que 106 dejó documentada.

## Qué hace

Introduce un **motor de posición en vivo**: una fuente que emite, mientras el usuario habla, en qué palabra de la respuesta modelo está (índice aproximado o exacto según la fuente disponible). Esa posición alimenta a dos consumidores en la vista karaoke:

1. **Pintado provisional palabra a palabra** — la palabra activa se marca en vivo (clase `kw-live`) durante la captura, distinta de los colores finales.
2. **Auto-scroll de la respuesta modelo** — el contenedor `karaoke-book` hace scroll para mantener la palabra activa visible mientras el usuario repite, sin intervención manual.

Los colores **finales** (green/amber/red) siguen llegando igual que hoy: `POST /api/attempt` → `alignWords` → `colorWords()` (106 + 116, sin cambios de contrato). El pintado en vivo es una capa provisional que se limpia al evaluar; el semáforo post-hoc tiene precedencia.

## Por qué

- **Scroll imposible durante captura:** barra oculta + SPACE bloqueado por PTT = texto desbordado inaccesible en justo el momento en que más se necesita (repitiendo la respuesta entera).
- **El usuario no debe soltar el micrófono para ver qué sigue:** hacer scroll a mano rompería el ritmo push-to-talk y desperdiciaría el turno.
- **Feedback inmediato:** ver la palabra activa avanzar da sensación de sincronía (mismo principio karaoke del coloreado post-hoc, pero en vivo).
- **El hook ya existe:** `browser-stt.js` emite interinos que hoy se descartan; 106 dejó documentado este camino como extensión futura.

## Requerimientos funcionales

- [ ] **Contrato de fuente de posición viva** — abstracción única (`LivePositionSource`) con una o más implementaciones, que emite el índice de la palabra activa del objetivo durante la captura. La spec no fija la tecnología de la fuente: la comparación de opciones (agenda temporal del coach / interims Web Speech / chunked whisper) y la decisión viven en `plan.md`.
- [ ] **Pintado provisional** — la palabra activa se marca con un estilo propio (`kw-live`, no confundible con `kw-spoken` del coach ni con `kw-green/amber/red`) mientras el usuario habla en la fase `full`; se limpia al soltar y antes del pintado post-hoc.
- [ ] **Auto-scroll durante captura** — al avanzar la posición, el `karaoke-book` mantiene la palabra activa visible (`scrollIntoView({ block: "nearest" })` sobre el wrap de la palabra, suavizado), sin scrollear fuera de fase y sin pelear con el popover léxico (112) ni con el gate `data-interactive` (113).
- [ ] **Monotonicidad** — durante una misma captura la posición solo avanza (los intermedios de STT se reescriben; la posición no debe "rebobinar" en vivo). El reset es al iniciar la captura y al evaluar.
- [ ] **Degradación** — si no hay fuente de posición disponible (ruta whisper sin interinos, fuente fallida), la fase `full` sigue funcionando como hoy: sin pintado en vivo y sin scroll en vivo; en ningún caso la feature bloquea la captura ni el envío a `/api/attempt`.
- [ ] **Precedencia post-hoc** — al llegar `words[]` de `/api/attempt`, `colorWords()` pinta el semáforo definitivo sobre la línea y el estado en vivo desaparece; el guard de refinado (`attemptId` + `flowToken`, 116) sigue intacto.
- [ ] **Cleanup garantizado** — la suscripción/animación se cancela en todos los caminos de salida de `captureAttempt` (éxito, fallo, excepción, soltar PTT), sin estado vivo colgando entre turnos.

## Requerimientos no funcionales

- Latencia del pintado/scroll: percibida como inmediata (< ~100 ms desde la señal de posición), sin bloquear el hilo de UI (rAF para el scroll suavizado).
- Presupuesto $0: sin dependencias nuevas ni endpoints nuevos obligatorios; frontend vanilla.
- Sin cambios de contrato: `/api/attempt`, `/api/transcribe`, `attempts[].words` y la forma de la sesión quedan como están.
- El servidor no participa en el camino de posición salvo que se elija la fuente chunked (ver `plan.md`); en la recomendación, la posición es 100% cliente.

## Decisiones de diseño / tecnología

- **Fuente de posición = decisión de plan (abierta en spec):** la spec define el contrato y los criterios; `plan.md` compara agenda temporal del coach, interims Web Speech y chunked whisper, y registra la decisión. Requisito transversal a cualquier fuente: disponible en la ruta por defecto (whisper local) o con degradación explícita.
- **"Exacto" es relativo a la fuente:** la capa en vivo es *provisional* (posición); la *exactitud de colores* (green/amber/red) la aporta 106/116 post-hoc, que no cambia. Esta feature no intenta emitir semáforo en vivo.
- **Fase `full` es el consumidor principal** (motivación del bug del texto oculto); el bucle de fragmentos queda fuera de alcance porque sus líneas cortas ya scrollean con `setCurrentLine`.

## Dependencias

- 106 (word timestamps + `alignWords`) y 116 (pintado incremental post-hoc) — se consumen, no se modifican.
- 111 (push-to-talk) — convive: la posición se recalcula mientras el botón/espacio está presionado; el cleanup ocurre al soltar.
- 112/113 (popover/click de palabra) — se respeta el gate `canInteractWithWords()`; el scroll en vivo no habilita interacción.
- 105 (vista karaoke: `rebuildBook`, `colorWords`, `spansForLine`).

## Criterios de aceptación

- [ ] Módulo puro de posición/scroll con tests (`tests/live-position.test.ts`): avance de índice, monotonicidad, tokenización alineada con `tokenizeWords`, degradación sin fuente, reset entre capturas.
- [ ] `npm run check` y `npm test` en verde.
- [ ] Prueba manual: respuesta modelo larga (desborda 46vh) → al presionar y repetir, la línea hace scroll sola y la palabra activa queda visible; soltar → semáforo post-hoc normal.
- [ ] Prueba manual sin fuente viva (ruta whisper / fuente deshabilitada) → flujo idéntico al actual, sin errores en consola ni scroll espurio.
- [ ] Prueba manual de regresión: popover léxico (112), click de palabra (113) y refinado amber (116) siguen operativos tras una captura con scroll en vivo.
- [ ] Verificación de cleanup: tras soltar PTT (y tras una excepción simulada), no quedan clases `kw-live` ni listeners/frames activos.

## Fuera de alcance

- Cambiar el alineador batch (`alignWords`), el contrato de `/api/attempt` o la persistencia de `attempts[].words`.
- Semáforo green/amber/red en vivo (sigue siendo post-hoc; la exactitud de color no se promete en tiempo real).
- Bucle de fragmentos (líneas cortas, ya con `setCurrentLine`).
- Streaming de audio al servidor / chunked whisper como requisito (queda como evolución opcional documentada en `plan.md`).
- Evaluar mientras se habla (la evaluación ocurre al soltar, como hoy).

## Recursos

- `public/ui/practice-view.js`, `public/ui/karaoke-color.js`, `public/speech/browser-stt.js`, `public/styles.css`.
- `spec/features/106-word-timestamps/spec.md` (§ Extensión futura), `spec/features/116-fast-fragment-eval/spec.md`, `spec/use-cases/CU2.md`, `spec/design/design-system.md:101`.
