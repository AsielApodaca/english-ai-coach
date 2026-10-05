# 118 · Reorganizar `src/lib` por dominio + renombrar módulos crudos

**Estado:** proposed 📝 (especificado, sin implementar)

## Contexto

- Motivo: el split de features 116/117 dejó **51 archivos sueltos en la raíz de `src/lib/`** (más `providers/` y `routes/`, que ya están organizados). Los grupos de dominio solo se intuyen por prefijo (`storage-*`, `practice-*`, `cu2-*`, `lookup-*`, `piper-*`); un agente o persona que abre el repo no sabe dónde empieza cada dominio. Además hay nombres crudos heredados: `cu2.ts` (del "Caso de Uso 2", invisible sin leer el spec) y `routes/chain.ts`.
- Decidido con el usuario (2026-10-04): feature **nueva apilada sobre 117** (diffs y review separados), alcance **mover + renombrar**, y **actualizar todos los imports** (sin barrels de re-export), aprovechando para cambiar el barrido `node --check` del script `check` por un `find` (la lista explícita de ~60 paths se rompe con cada move).
- Este spec es **autocontenido**: una sesión sin contexto previo implementa la feature leyendo este directorio + `AGENTS.md`.
- Rama: `refactor/118-lib-domain-folders` (apilada sobre `refactor/117-ai-readable-backend`). Commits en inglés, uno por dominio.

### Diagnóstico (verificado 2026-10-04 contra `main` + rama 117)

- **Churn de imports:** 83 líneas `from "…lib/…"` en `src/` + `tests/`; ningún fichero de `public/` referencia rutas de backend (solo HTTP).
- **Paths fijos en tests:**
  - `tests/cu2.test.ts:30-33` lee `src/lib/{cu2,cu2-state,cu2-transitions,cu2-lines}.ts` por path para sus aserciones regex.
  - `tests/verbatim-invariant.test.ts:39` (comentario) y el resto de tests solo.walk-ean o leen `public/` y `data/tmp` — sin paths de lib.
  - `tests/app-http.test.ts:93` importa `src/lib/app.ts` (no se mueve).
- **`package.json` `check`:** lista explícita de ~60 `node --check <path>`; cualquier move obliga a editarla. `tests/type-gate.test.ts` fija (a) `tsc --noEmit` primero y (b) que **cada** `public/**/*.js` aparezca en la lista — hay que adaptarla al barrido.
- **Referencias en docs:** `AGENTS.md` (sección Estructura), `README.md`, `spec/constitution/{roadmap,tech-stack}.md`, `spec/features/105-*/spec.md` y `117` mencionan paths concretos (`src/lib/cu2.ts`, etc.).
- **12 ficheros** referencian `cu2` (4 propios + 8 imports): `practice-eval`, `refinement`, `session-payload`, `routes/practice`, `routes/attempt` y los tests `coach`, `cu2`, `verbatim-invariant`.

### Mapa destino (51 → carpetas de dominio)

```
src/lib/
├── app.ts, http-errors.ts          # wiring HTTP (únicos en la raíz)
├── routes/ ✅ (11)  providers/ ✅ (6)
├── session/     storage.ts, storage-session.ts, storage-profile.ts,
│                storage-context.ts, session-types.ts, session-guards.ts,
│                session-start.ts, session-payload.ts, json-file.ts,
│                attempt-persist.ts                                        (10)
├── practice/    practice.ts, practice-eval/generate/text.ts,
│                cu2*→karaoke*.ts, continuous.ts, continuous-adaptive/
│                generate/handler.ts, align.ts, align-words/text.ts,
│                learner.ts, refinement.ts                                 (17)
├── audio/       whisper.ts, piper.ts, piper-voices.ts, edge-tts.ts,
│                tts-cache.ts, tts-status.ts, prosody.ts, wav.ts           (8)
├── lookup/      lookup.ts, lookup-types/validate/providers/resolve.ts     (5)
├── ingest/      extract.ts, extract-parse.ts, extract-handler.ts          (3)
├── settings/    settings.ts, settings-types.ts                            (2)
└── util/        subprocess.ts, time.ts                                    (2)
```

**Renames:** `cu2.ts` → `karaoke.ts`, `cu2-state.ts` → `karaoke-state.ts`, `cu2-transitions.ts` → `karaoke-transitions.ts`, `cu2-lines.ts` → `karaoke-lines.ts` (el vocabulario karaoke ya vive en `tests/karaoke-*.test.ts`, `public/ui/karaoke-*.js` y la feature `105-karaoke-practice-cu2`); `routes/chain.ts` → `routes/candidate-chain.ts`.

## Qué hace

Mover cada módulo a la carpeta de su dominio, renombrar los crudos, actualizar **todos** los imports (sin re-export en rutas viejas), convertir el barrido sintáctico del script `check` en un `find` sobre `src`+`public`, adaptar los tests que fijan paths y actualizar la documentación que los menciona. Refactor de paths **sin cambio de comportamiento**.

## Por qué

- **Legibilidad (regla central de 117/AGENTS):** un agente que abre `src/lib/` ve de un vistazo los 7 dominios; el "porqué" de cada fichero se lee por su carpeta, no por prefijos recordados.
- **Escalabilidad:** cada feature nueva sabe dónde vive (¿TTS? → `audio/`) en vez de acumular archivos en la raíz.
- **Nombres que explican:** `karaoke-*` se entiende sin conocer la numeración de casos de uso; `chain` → `candidate-chain` describe la cadena de candidatos LLM.
- **Gate mantenible:** el `find` elimina la lista explícita de paths que habría que re-editar en cada move futuro.

## Criterios de aceptación

- [ ] `npx tsc --noEmit` → 0 errores; `npm test` → verde; `npm run check` → verde tras cada commit.
- [ ] La raíz de `src/lib/` contiene únicamente `app.ts` y `http-errors.ts` (además de las carpetas `routes/`, `providers/`, `session/`, `practice/`, `audio/`, `lookup/`, `ingest/`, `settings/`, `util/`).
- [ ] Cero archivos `*.ts` fuera de la carpeta de su dominio según el mapa de arriba.
- [ ] Sin barrels de re-export en las rutas viejas: ningún `export * from` que oculte la ubicación real.
- [ ] `grep -rn "cu2" src/ tests/` → 0 coincidencias (quedan solo en `spec/` como nombre histórico del CU2).
- [ ] El script `check` barre `src` y `public` con `find` (lista explícita eliminada) y sigue ejecutando `tsc --noEmit` primero; `tests/type-gate.test.ts` adaptado y en verde.
- [ ] `tests/cu2.test.ts` lee las fuentes desde la ruta nueva (o renombrado a `karaoke.test.ts` — decisión en plan.md) y pasa sin reescribir aserciones.
- [ ] `AGENTS.md`, `README.md`, `spec/constitution/{roadmap,tech-stack}.md` y las menciones de paths en `spec/features/` reflejan la estructura real.
- [ ] Sin dependencias npm nuevas; sin cambios de comportamiento HTTP ni de datos.

## Fuera de alcance

- Cambiar firmas, contratos `/api/*` o lógica de negocio (es movimiento puro + renombres).
- Renombrar carpetas/ficheros no listados (se decidirá en features futuras si aparecen).
- Frontend `public/` (no referencia rutas de backend).
- Reorganizar `tests/` (sigue plano por `*.test.ts`, convención vigente).

## Recursos

- `AGENTS.md` (Convenciones, Estructura, No hagas), `spec/constitution/tech-stack.md`.
- Plan detallado: `plan.md`; checklist: `tasks.md`.
- Features previas: `117-ai-readable-backend` (split de módulos y `createApp`), `105-karaoke-practice-cu2` (vocabulario karaoke).
