# 121 · Coloreado en tiempo real exacto + auto-scroll de la respuesta modelo — Plan

## Enfoque

La spec fija el contrato (`LivePositionSource` → índice de palabra activa) y sus dos consumidores (pintado provisional `kw-live` + auto-scroll de la respuesta modelo en fase `full`), pero deja la fuente de posición abierta. Este plan compara las tres fuentes candidatas, registra la decisión y esboza la implementación.

Idea central: **la spec no necesita "exactitud de color" en vivo** — necesita saber *por dónde va el usuario* para scrollear; la exactitud (colores y timestamps) la sigue aportando 106/116 post-hoc sin tocar contratos. Por eso la fuente puede ser aproximada donde haga falta y el sistema degrada sin romper el flujo.

## Comparación de fuentes de posición (decisión)

| | A · Agenda temporal del coach | B · Interims Web Speech | C · Chunked whisper al servidor |
|---|---|---|---|
| **Cómo** | Reutilizar los `onsets` de lectura (`buildWordStarts`, `public/ui/karaoke-schedule.js:37`) y mapear tiempo transcurrido de captura → índice de palabra | Enganchar `onInterim` (`browser-stt.js:42`, ya existe sin consumir) y alinear el parcial contra el target con un matcher greedy incremental | Enviar ventanas de audio durante la captura y transcribir parciales con `transcribeWords` |
| **Disponible en la ruta por defecto (whisper local)** | ✅ sí | ❌ solo en la ruta fallback del navegador | ✅ sí |
| **Exactitud** | Baja–media (ritmo del usuario ≈ del coach, no idéntico; no detecta pausas/repeticiones) | Media–alta en texto (el STT va tras el habla; sin timestamps por palabra) | Alta (timestamps reales del habla del usuario) |
| **Coste** | ~0, todo cliente, sin STT | ~0, hook ya declarado; requiere matcher incremental cliente | Alto: endpoint incremental, ventanas repetidas, CPU de whisper durante la captura, `spawnSync` → async, latencia por ventana |
| **Dependencias** | Ninguna | Web Speech API (no disponible en todos los navegadores/offline) | Servidor local activo durante captura (hoy la captura no lo toca) |

**Decisión: híbrido A + B bajo un único contrato `LivePositionSource`, con C como evolución documentada.**

- **A como baseline universal** — funciona en todas las rutas (incluida la por defecto whisper), cero coste, offline; es suficiente para el consumidor principal (auto-scroll: solo necesita "por dónde va", no el color exacto).
- **B cuando exista** — si la ruta activa es Web Speech, los interimos refinan la posición (texto real del usuario) por encima de la agenda temporal.
- **C queda fuera** — se documenta como evolución si algún día se quiere posición exacta en la ruta whisper; el contrato ya lo absorbería sin tocar los consumidores.

La monotonía de la posición (solo avanza durante una captura) mitiga el principal defecto de A/B: los reescribidos de interinos y las pausas no "rebobinan" el scroll.

## Implementación

1. `public/ui/live-position.js` (nuevo, puro) — módulo sin DOM ni efectos:
   - `tokenize`/normalización reutilizando `tokenizeWords` de `public/ui/karaoke-color.js`.
   - `advanceLiveIndex(prevIndex, targetTokens, spokenParcial)` → matcher greedy monotónico (el parcial solo puede empujar el índice hacia delante).
   - `timeLiveIndex(targetTokens, wordOnsetsMs, elapsedMs)` → índice desde la agenda temporal del coach (`buildWordStarts` de `public/ui/karaoke-schedule.js`), escalado al tiempo de captura transcurrido.
   - Fábrica `createLivePositionSource({ kind: "time" | "interim", … })` con contrato único `{ start(), stop(), onWord(cb) }`.
2. `public/ui/practice-view.js`:
   - En `captureAttempt()` (1022), solo en fase `full`: crear la fuente, `onWord(i)` → pintar `kw-live` en el span `i` + `spansForLine(-1)[i].scrollIntoView({ block: "nearest", behavior: "smooth" })` (con guard de frames para no saturar).
   - Ruta browser: pasar `onInterim` del recognizer (`captureBrowserSpeech`, 1203) a `advanceLiveIndex`; ruta whisper: fuente `time`.
   - Cleanup en `finally` (éxito/fallo/excepción): quitar `kw-live`, `stop()` la fuente. El pintado post-hoc (`renderFeedback` → `colorWords`) sigue después, intacto.
   - Reset de índice al inicio de cada captura (nueva ronda = nuevo índice 0).
3. `public/styles.css` — clase `.kw-live` (tono propio, no el cian de `kw-spoken`), transición corta de scroll y `scroll-padding-block` en `.karaoke-book` para que la máscara gradiente no tape la palabra activa en los bordes (46vh con `mask-image`).
4. `public/speech/browser-stt.js` — sin cambios de contrato (el hook `onInterim` ya existe); solo se consume desde la vista.
5. `tests/live-position.test.ts` (nuevo) — lógica pura: avance, monotonicidad (interinos reescritos no rebobinan), mapeo tiempo→índice con onsets, reset, degradación sin fuente (`node:test` + `node:assert`, como el resto).
6. Docs: esta carpeta, entrada de roadmap y el puntero en `../106-word-timestamps/spec.md` (§ Extensión futura).

## Decisiones

- **Híbrido A+B en vez de C (chunked whisper)** — C es la única fuente exacta en la ruta por defecto, pero cuesta un endpoint nuevo, CPU durante la grabación y convertir una captura hoy 100 % local-en-memoria en un flujo con round-trips; el beneficio para el auto-scroll (el consumidor principal) es marginal frente a A. Se deja documentada para no romper la evolución.
- **Contrato único con implementaciones intercambiables** — evita que los consumidores (`kw-live` + scroll) se case a una tecnología de STT; añadir C después no toca la vista.
- **Posición monotónica por captura** — los interinos de STT se reescriben y una agenda puede adelantar; sin este invariante el scroll vibra. Alternativa descartada: permitir retroceso "para corregir" — el post-hoc de 106 ya corrige los colores, no hace falta corregir el scroll en vivo.
- **`kw-live` ≠ `kw-spoken`** — `kw-spoken` (cian) marca la lectura del coach (`animateWordProgress`, rAF) y ya tiene semántica de "se está hablando ahora"; el estado del usuario necesita su propia clase para poder limpiarse por separado sin tocar ese flujo.
- **Scroll sobre el wrap de la palabra, no sobre la línea** — en fase `full` la respuesta es **una sola línea**; `scrollIntoView` de la línea (lo que hace `setCurrentLine`) no sirve de nada ahí. El `block: "nearest"` + `scroll-padding-block` evita que la palabra quede bajo la máscara gradiente.
- **Cleanup en `finally` de `captureAttempt`** — PTT tiene muchos caminos de salida (soltar, error de permisos, excepción); un frame o listener colgado pintaría `kw-live` en la siguiente ronda.

## Riesgos

- **Posición atrasada/adelantada con agenda temporal (A)** — el usuario puede hablar más rápido/lento que el coach o pausar; mitigación: monotonicidad + suavizado + la corrección definitiva llega con el post-hoc. Aceptado como trade-off de la ruta whisper sin streaming.
- **Falsos positivos de interinos (B)** — un interim reescrito con errores del recognizer mueve la posición mal; mitigación: solo avance monotónico y techo = última palabra del target.
- **Doble fuente de "estado hablado" en UI** — `kw-live` y `kw-spoken` podrían solaparse si el coach aún lee; la fase `full` espera a que termine la lectura antes de capturar, pero se verifica manualmente.
- **Máscara/degradado tape la palabra** — riesgo visual; cubierto con `scroll-padding-block` y prueba manual en los bordes del contenedor.
- **Web Speech no disponible (Safari/offline)** — degradado a A por diseño; ningún camino queda sin fallback.
