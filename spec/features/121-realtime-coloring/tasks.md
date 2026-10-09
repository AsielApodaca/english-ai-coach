# 121 · Coloreado en tiempo real exacto + auto-scroll de la respuesta modelo — Tasks

- [x] Crear `public/ui/live-position.js` (módulo puro, sin DOM): matcher greedy monotónico `advanceLiveIndex`, agenda temporal `timeLiveIndex` sobre `buildWordStarts` y fábrica `createLivePositionSource({ kind })` con contrato `{ start(), stop(), onWord(cb) }`.
- [x] `tests/live-position.test.ts` (`node:test` + `node:assert`): avance, monotonicidad con interinos reescritos, mapeo tiempo→índice, techo en la última palabra, reset por captura y degradación sin fuente.
- [x] `public/styles.css`: clase `.kw-live` (distinta de `kw-spoken`) y `scroll-padding-block` en `.karaoke-book` para que la máscara gradiente no tape la palabra activa.
- [x] `public/ui/practice-view.js`: en `captureAttempt()` fase `full`, crear la fuente y enganchar `onWord` → pintar `kw-live` + `scrollIntoView({ block: "nearest" })` sobre el wrap de la palabra (con guard de frames); cleanup en `finally` (quitar clase + `stop()`); reset de índice al iniciar cada captura.
- [x] `public/ui/practice-view.js` (ruta browser): pasar `onInterim` de `captureBrowserSpeech()` a `advanceLiveIndex`; ruta whisper: fuente `time`.
- [x] Verificar precedencia post-hoc: `renderFeedback` → `colorWords()` sigue pintando el semáforo definitivo tras una captura con scroll en vivo, sin clases `kw-live` residuales (guard 116 intacto).
- [x] Verificar convivencia: popover léxico (112), click de palabra (113), refinado amber (116) y PTT (111) operativos tras capturas con scroll en vivo.
- [x] `npm run check` y `npm test` en verde.
- [ ] Manual: respuesta modelo larga (desborda 46vh) → scroll automático durante la repetición, palabra activa visible bajo la máscara, semáforo normal al soltar.
- [ ] Manual sin fuente viva (ruta whisper / fuente caída): flujo idéntico al actual, sin scroll espurio ni errores en consola.
- [x] Actualizar esta carpeta, mover la feature a "Hecho ✅" en `../../constitution/roadmap.md` y el puntero en `../106-word-timestamps/spec.md` (§ Extensión futura).
