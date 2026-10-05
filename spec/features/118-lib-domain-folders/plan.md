# 118 · Reorganizar `src/lib` por dominio — Plan

## Enfoque

Nueve commits en la rama apilada, cada uno con `npm test` + `npm run check` en verde antes de pasar al siguiente. **Orden: primero el `check` con `find`** (así ningún move posterior obliga a re-editar la lista de paths), luego un commit por dominio (`git mv` + actualización de imports + fixes de tests que fijan paths), los renombres dentro del commit del dominio al que pertenecen, y los docs al final. Regla transversal: movimiento puro — ninguna firma, contrato ni comportamiento cambia; si un move requiere tocar lógica, se para y se documenta en vez de mezclar.

## Implementación

### Commit 1 — `check` con `find`
1. `package.json`: el script `check` pasa de ~60 `node --check <path>` explícitos a un barrido:
   `npx tsc --noEmit && find src public \( -name '*.ts' -o -name '*.js' \) -print0 | xargs -0 -n 1 node --check`
   (tsc primero, como exige el test; `find` con `\(...\)` para que el `-o` no tenga precedencia errónea; `-print0/-xargs -0` para tolerar espacios.)
2. `tests/type-gate.test.ts`: el test "syntax-checks every frontend JS file" deja de fijar `node --check public/<file>` fichero a fichero y pasa a fijar que el barrido cubre `src` **y** `public` (p. ej. un `find src public` presente en el script). Se conservan los tests de `tsc` primero.
3. Verificar que el barrido cubre los mismos ficheros que antes (los 60 de la lista + los 5 que se añadieron en 117) y que sale limpio.

### Commit 2 — `session/` (10 ficheros)
`git mv` de `storage.ts`, `storage-session.ts`, `storage-profile.ts`, `storage-context.ts`, `session-types.ts`, `session-guards.ts`, `session-start.ts`, `session-payload.ts`, `json-file.ts`, `attempt-persist.ts` → `src/lib/session/`.
Actualizar imports internos (relativos: `./storage.ts` → `../storage.ts` dentro de la carpeta se mantiene igual entre hermanos; los que entran desde fuera cambian a `../session/storage.ts` o `./session/storage.ts` según capa) y todos los consumidores (`routes/*`, `app.ts`, tests).

### Commit 3 — `practice/` + rename `cu2*` → `karaoke*` (17 ficheros)
Mover `practice.ts`, `practice-{eval,generate,text}.ts`, `cu2*.ts` (renombrados a `karaoke.ts`, `karaoke-state.ts`, `karaoke-transitions.ts`, `karaoke-lines.ts`), `continuous.ts` + `continuous-{adaptive,generate,handler}.ts`, `align.ts`, `align-{words,text}.ts`, `learner.ts`, `refinement.ts` → `src/lib/practice/`.
- Actualizar los 12 ficheros que referencian `cu2` (imports + comentario de `verbatim-invariant.test.ts:39`).
- `tests/cu2.test.ts`: paths de lectura `["cu2.ts", …]` → `["karaoke.ts", …]` bajo `src/lib/practice/`. **Decisión:** renombrar el fichero de test a `karaoke.test.ts` (coherencia total; las aserciones no cambian) — se renombra en este mismo commit.
- `grep -rn "cu2" src/ tests/` → 0 antes de cerrar el commit.

### Commit 4 — `audio/` (8 ficheros)
`whisper.ts`, `piper.ts`, `piper-voices.ts`, `edge-tts.ts`, `tts-cache.ts`, `tts-status.ts`, `prosody.ts`, `wav.ts` → `src/lib/audio/`.

### Commit 5 — `lookup/` (5) · Commit 6 — `ingest/` (3) · Commit 7 — `settings/` (2) · Commit 8 — `util/` (2)
Moves simples + imports. `extract*` → `ingest/` (ingesta de contexto, feature 104); `subprocess.ts`, `time.ts` → `util/` (infraestructura compartida de constantes).

### Commit 9 — rename `routes/chain.ts` → `routes/candidate-chain.ts`
Solo lo consume `routes/` (practice/attempt/session…): 4-5 imports internos.

### Commit 10 — Documentación
- `AGENTS.md` sección *Estructura del proyecto* (árbol y descripciones con paths nuevos; `cu2.ts` → `karaoke.ts`).
- `README.md` (estructura/comandos), `spec/constitution/tech-stack.md` (módulos clave y comando `check`), `spec/constitution/roadmap.md` (118 → Hecho ✅).
- Menciones de paths en `spec/features/105-*/spec.md` y `spec/features/117-*/spec.md` (solo las que citan `src/lib/…` como ubicación actual; los diagnósticos históricos con `git` no se reescriben).
- Estado `done` + criterios tildados en este `spec.md`.

## Decisiones

- **Apilar sobre 117 en vez de mezclar** — 117 ya está revisado y aprobado; reabrir su diff con ~80 ficheros movidos destruiría la trazabilidad del review. PRs encadenados: 118 → 117.
- **Actualizar todos los imports, sin barrels** — los barrels dejan `storage.ts` en la raíz como indirection permanente (media reorganización); el proyecto prefiere código literal. El churn son ~83 líneas, mecánico y verificado por tsc.
- **`karaoke*` para `cu2*`** — vocabulario ya usado por tests (`karaoke-*.test.ts`), frontend (`public/ui/karaoke-*.js`) y feature `105-karaoke-practice-cu2`; "cu2" solo se entiende con el spec de casos de uso. Descartado `practice-state*` (colisiona con `practice.ts` y es más vago).
- **`find` en `check`** — sustituir 60 paths explícitos por un barrido elimina la lista que habría que re-editar en cada move futuro; se mantiene `tsc --noEmit` primero (orden pinado por test). Alternativa descartada: seguir ampliando la lista a mano (falla en el siguiente move).
- **Un commit por dominio** — rollback por dominio si algo se rompe; `git mv` preserva el historial de cada fichero.
- **`ingest/` para `extract*`** — nombre del dominio (ingerir archivos de contexto) sin chocar con `routes/files.ts` (el endpoint) ni con `session/contextFiles`.
- **`util/` solo para `subprocess`/`time`** — constantes de infra compartidas; los dominios siguen teniendo sus constantes junto a su código (regla de 117), no se crea un `constants.ts` global.

## Riesgos

- **Import path incorrecto en un consumidor poco usado** — cubierto por `tsc --noEmit` (cero tolerancia) antes de cada commit; ningún move se commitea con el gate rojo.
- **Tests que leen fuentes por path** (`cu2.test.ts`) — se actualizan en el mismo commit del move; sus aserciones sobre el contenido no cambian.
- **`tests/type-gate.test.ts` se vuelve rojo con el `find`** — se adapta en el commit 1, antes de cualquier move.
- **Diffs de renombre confundidos con cambios de contenido** — `git mv` + renombres propios de git detectados en review; el cuerpo del commit documenta qué es rename y qué es move.
- **Paths citados en specs históricos** — solo se actualizan los que afirman ubicación actual; los diagnósticos fechados de 117 (líneas con `server.ts`) se dejan como registro histórico.
