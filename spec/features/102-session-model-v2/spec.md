# 102 · Session model v2 — sesión continua reanudable

**Estado:** done ✅

## Contexto

- Casos de uso: CU3 (historial con progreso separado), CU2 (progreso por pregunta), CU1 (config snapshot).
- Pantallas: sidebar de Config/Práctica; `screens.md` items 1, 2.
- Base existente: `src/lib/storage.ts`, `src/lib/learner.ts`, modelo de datos en `spec/constitution/tech-stack.md` (§ Modelo de datos / dominio).

## Qué hace

Redefine el schema de sesión de "una sola pregunta con fragmentos" a **sesión continua** con múltiples preguntas, estado de vida (`active`/`completed`), snapshot de configuración para poder reanudar y atributos de agrupación para el historial (Today/Yesterday/7 días). Persistencia idempotente (save de estado completo en cada checkpoint) y migración de las sesiones v1 guardadas por la app actual.

## Por qué

CU3 exige sesiones separadas con progreso diferenciado y reanudables; el modelo v1 (`{id, date, category, level, question, fragments, nextStep}` de una sola pregunta) no puede representar el progreso de un diálogo Q1→Q∞ ni el estado "practice iniciada, incompleta". Sin esto, 105/107/109 no tienen dónde escribir.

## Requerimientos funcionales

- [ ] Schema v2 (detalle en `tech-stack.md`):
      `{ id, status: "active"|"completed", createdAt, updatedAt, config, provider, questions[] }`
      donde `config = { topicPrompt, level, category, accent, phonemes[], contextFiles[], settingsSnapshot }`
      y `questions[] = [{ q, answer, fragments:[{ id, text, attempts[], passed }], fullAttempt, eval }]`.
- [ ] `attempts[]` por fragmento: `{ text, words:[{ word, status:"green"|"amber"|"red" }], score, startedAt, durationMs }` (conformante con 106).
- [ ] Operaciones de `storage.ts`: `createSession(config) → id`, `saveSession(session)` (idempotente, reemplaza archivo completo), `loadSession(id)`, `listSessions({ status?, since?, limit })`, `groupSessionsByRecency(sessions)` (Today/Yesterday/7 días/todo).
- [ ] Migración v1→v2: una sesión v1 se lee como `questions:[{ q: session.question, answer: session.fullAnswer, fragments, fullAttempt: null, eval: null }]`; nunca se reescribe sobre el archivo v1 (lectura compañera de compatibilidad).
- [ ] Niveles: enum ampliado `A1..C2`; migración de perfil guarda niveles v1 (B1/B2/C1) válidos.
- [ ] Contracción de la precondición CU3: **no se crea sesión si el usuario no presiona "Iniciar práctica"** (sin config sin session).
- [ ] `updatedAt` se actualiza en cada checkpoint (para agrupación del historial 109).

## Requerimientos no funcionales

- Guardado atómico: escribir a temp + rename (evita corrupción si se corta durante grabación). 
- El `topicPrompt` no debe incluirse truncado en listados de historial (solo `title` derivado, 109).
- Backward-compatible: la app v1 sigue leyendo sus propias sesiones.

## Decisiones de diseño / tecnología

- `title` de sesión derivado por LLM (resumen del rol del usuario, 1 línea) en creación; si falla, primeras N palabras del canal topicPrompt.
- Categoría: en el shell v2 la "categoria de práctica" pasa a derivarse del topic/config; se conserva el enum existente con valores por defecto en migración.
- No se duplican settings completas: `settingsSnapshot` guarda solo overrides del usuario (delta) + versión de settings para resolver defaults al reanudar.

## Dependencias

- Ninguna funcional nueva; depende de `storage.ts`/`learner.ts`.

## Criterios de aceptación

- [x] Tests unitarios de `storage` cubren create/load/save idempotente/migración v1→v2/groupByRecency.
- [x] Crear una sesión sin start no genera archivo (`tests/storage`).
- [x] `npm test` y `npm run check` pasan.

## Fuera de alcance

- UI de historial/reanudación (109). Contenido de la práctica sobre el modelo (105/107). Config (103).

## Recursos

- `src/lib/storage.ts`, `src/lib/learner.ts`, `tests/storage.test.ts`; `spec/use-cases/CU3.md`; `spec/constitution/tech-stack.md`.