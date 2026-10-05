# 118 · Reorganizar `src/lib` por dominio — Tareas

## Commit 1 — `check` con `find`

- [ ] `package.json` → `check`: reemplazar la lista explícita de `node --check` por `find src public \( -name '*.ts' -o -name '*.js' \) -print0 | xargs -0 -n 1 node --check` (tsc primero).
- [ ] `tests/type-gate.test.ts`: adaptar el test de cobertura de `public/**/*.js` al barrido `find`; conservar los tests de orden `tsc` primero.
- [ ] Verificar que el barrido cubre los ficheros de la lista anterior y `npm run check` sale limpio.

## Commit 2 — `session/` (10)

- [ ] `git mv` de `storage`, `storage-session`, `storage-profile`, `storage-context`, `session-types`, `session-guards`, `session-start`, `session-payload`, `json-file`, `attempt-persist` → `src/lib/session/`.
- [ ] Actualizar imports internos y de todos los consumidores (`routes/*`, `app.ts`, `server.ts`, tests).

## Commit 3 — `practice/` + `cu2*` → `karaoke*` (17)

- [ ] `git mv` de `practice*`, `cu2*→karaoke*`, `continuous*`, `align*`, `learner`, `refinement` → `src/lib/practice/`.
- [ ] Renombrar: `cu2.ts`→`karaoke.ts`, `cu2-state`→`karaoke-state`, `cu2-transitions`→`karaoke-transitions`, `cu2-lines`→`karaoke-lines`.
- [ ] Actualizar los 12 ficheros que referencian `cu2` (incluye comentario de `verbatim-invariant.test.ts:39`).
- [ ] `tests/cu2.test.ts` → renombrar a `tests/karaoke.test.ts` y actualizar los paths de lectura de fuentes.
- [ ] `grep -rn "cu2" src/ tests/` → 0.

## Commit 4 — `audio/` (8)

- [ ] `git mv` de `whisper`, `piper`, `piper-voices`, `edge-tts`, `tts-cache`, `tts-status`, `prosody`, `wav` → `src/lib/audio/`.
- [ ] Actualizar imports consumidores.

## Commits 5-8 — dominios restantes

- [ ] `lookup/` (5): `lookup`, `lookup-types`, `lookup-validate`, `lookup-providers`, `lookup-resolve`.
- [ ] `ingest/` (3): `extract`, `extract-parse`, `extract-handler`.
- [ ] `settings/` (2): `settings`, `settings-types`.
- [ ] `util/` (2): `subprocess`, `time`.

## Commit 9 — rename menor

- [ ] `routes/chain.ts` → `routes/candidate-chain.ts` + sus imports internos.

## Commit 10 — Documentación

- [ ] `AGENTS.md` sección *Estructura del proyecto* con los paths nuevos.
- [ ] `README.md`, `spec/constitution/tech-stack.md` (módulos + comando `check`).
- [ ] `spec/constitution/roadmap.md`: 118 → Hecho ✅.
- [ ] Menciones de ubicación actual en `spec/features/105-*` y `117-*`.
- [ ] Este spec: estado `done` + criterios verificados.

## Verificación final

- [ ] `npx tsc --noEmit` 0 · `npm test` verde · `npm run check` verde.
- [ ] Raíz de `src/lib/` solo `app.ts` + `http-errors.ts` (+ carpetas).
- [ ] `grep -rn "cu2" src/ tests/` → 0.
- [ ] Cero `export * from` en rutas viejas (sin barrels).
