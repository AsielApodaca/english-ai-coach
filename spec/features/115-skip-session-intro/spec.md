# 115 · Quitar la introducción: la sesión empieza en la pregunta

**Estado:** implementado ✅ (ola 7 — lista para PR)

## Contexto

- Caso de uso: CU2, paso 1 (introducción + explicación de la dinámica) y paso 6 (explicación del método fragmento a fragmento) (`../../use-cases/CU2.md`).
- Pantallas: vista de práctica (`#/practice/<id>`) — transición desde el modal "Iniciando Sala de Audio" de CU1.
- Base:
  - `src/lib/cu2.ts` — fases `intro → question → model → explaining → repeatingFragment → …`; `buildIntroText()` (locución fija "Welcome to your practice session. Here is how it works…"), `buildExplainLine()` ("Now let's practice. I will read the answer in short fragments…"), `buildFullLine()` ("Now say the full answer…" — **se conserva**).
  - `src/server.ts` — `GET /api/session/:id` devuelve `{ intro, explainLine, fullLine, … }`.
  - `public/ui/practice-view.js` — `runFlow()` habla `introText` (omitido en resume), `runQuestionLoop()` habla `explainLine` antes del primer fragmento y `fullLine` antes de la respuesta completa.
- Decisiones registradas (sesión de especificación): **eliminar `intro` y `explainLine`**; **conservar `fullLine`**. La sesión arranca directamente en la generación/lectura de la pregunta.

## Qué hace

Elimina las locuciones de apertura y de dinámica. Al entrar a la práctica (o reanudar/sigue pregunta), el primer sonido que emite el coach es **la pregunta**; tras la respuesta modelo, el coach pasa **directo al primer fragmento** sin explicar el método. La respuesta completa conserva su instrucción (`fullLine`).

## Por qué

- **Arranque inmediato:** cada sesión arranca con ~15–20 s de locución de relleno ("Welcome… Here is how it works…", "Now let's practice…") que el usuario —que ya practicó antes— no necesita; el tiempo efectivo de práctica por sesión baja.
- **Consistencia con el resto del flujo (110):** la filosofía ya elegida es "sin rodeos, directo al grano"; la intro contradice ese principio.
- **Menos fricción en reanudación:** el resume ya saltaba la intro; ahora el flujo es uniforme (siempre empieza en la pregunta).

## Requerimientos funcionales

- [x] **Sin intro:** no se locuta `buildIntroText` en ningún caso (primer inicio, resume, "hacer otra práctica", siguiente pregunta de sesión continua). El flujo arranca en la fase `question` (mostrar + leer la pregunta).
- [x] **Sin explicación de dinámica:** no se locuta `buildExplainLine` — de la lectura de la respuesta modelo se pasa **directo** al resaltado y lectura del primer fragmento. El resaltado visual del fragmento activo (paso 7 del CU2) **se conserva** (es visual, no hablado).
- [x] **Fases eliminadas del reducer:** `intro` y `explaining` se **eliminan** de la máquina de estados de `src/lib/cu2.ts` (transiciones y guards asociados), no se dejan como fases muertas. Diagrama resultante: `question → model → repeatingFragment → feedback ⇄ repeatingFragment → fullAnswer → done`.
- [x] **Payload del server:** `GET /api/session/:id` deja de devolver `intro` y `explainLine` (contrato actualizado en la misma feature). `fullLine` y el resto del payload se conservan. *Alternativa compatible* (si se prefiere no romper clientes viejos): mantener los campos con `null` y que el cliente los ignore — elegir una y reflejarla en tests.
- [x] **Clientes consumidores:** `practice-view.js` elimina los `await speak(introText)` / `await speak(explainLine)` y sus branches de resume relacionados; ningún otro consumidor queda hablando esos textos.
- [x] **`buildIntroText`/`buildExplainLine`:** se **eliminan** (código + tests) junto con sus constantes; no se conservan "por si acaso". `buildFullLine` permanece intacto.
- [x] **Semántica de "empieza donde genera la pregunta":** el primer evento del flujo es la **generación/carga de la pregunta** (ya creada en `POST /api/session/start`) + su lectura TTS + mostrarla en pantalla — sin ninguna frase previa hablada.
- [x] **`fullLine` intacta:** antes de la respuesta completa el coach sigue instruyendo con `buildFullLine()` (decisión explícita del usuario).
- [x] **Documento CU2 actualizado:** la tabla de "Interpretación técnica" de `spec/use-cases/CU2.md` (filas **Intro** y **Explicación**) y los pasos 1 y 6 se ajustan para reflejar este flujo, dejando constancia del cambio de decisión (el texto oficial del producto se marca como modificado, no se reescribe en silencio).
- [ ] **Sin regresión de estados UI:** el panel/orb/dock durante el primer instante de la práctica muestran el estado "pregunta" (no un estado vacío de intro); no hay pantalla en blanco entre el modal de inicio y la pregunta. *(Verificación visual — queda en el checklist manual pre-merge.)*

## Requerimientos no funcionales

- Ahorro de tiempo por sesión: elimina ~15–20 s de locución de arranque (medir en checklist).
- Tests del reducer: actualizar `tests/cu2.test.ts` (transiciones, guards y textos de intro/explicación) sin perder cobertura de las fases restantes.
- Sin dependencias nuevas; sin cambios en la generación LLM de preguntas.

## Decisiones de diseño / tecnología

- **Eliminar fases vs hacerlas no-op:** elegido eliminar (muerte de `intro`/`explaining`): evita código muerto y estados imposibles de alcanzar; costo aceptado = actualizar el reducer y sus tests.
- **Eliminar campos del payload vs `null`:** preferencia por eliminarlos (contrato limpio); se registrará en el PR la elección final y se cubrirá con test de shape del payload.
- **Conservar `fullLine`:** decisión del usuario — el salto de fragmentos a respuesta completa es el punto de mayor riesgo de confusión ("¿y ahora qué hago?"), a diferencia de la intro (contexto ya conocido).
- **Riesgo documentado para usuarios nuevos:** sin la explicación de la dinámica, un usuario de primera sesión puede no entender el flujo escucha-repite. Mitigación documentada (fuera de alcance aquí): un hint visual no hablado en la primera sesión (p. ej. chip "Mantén espacio para hablar") — ver Extensión futura.

## Dependencias

- 105 (orquestación de fases — modifica `runFlow`/`runQuestionLoop`).
- 107 (siguiente pregunta — hereda el arranque sin intro).
- 110 (chime) — convive: el orden resultante en un loop es `chime → siguiente fragmento (verbatim)`.
- 102 (`GET /api/session/:id` — shape del payload).

## Criterios de aceptación

- [x] `tests/cu2.test.ts` actualizado: el reducer **no** tiene fases `intro` ni `explaining` (grep/assert de ausencia), arranca en `question`, `model → repeatingFragment` es directo, `fullAnswer` conserva `buildFullLine`, y todas las transiciones restantes tienen su test.
- [x] Test de "cero locuciones de apertura": una pregunta completa simulada en el reducer no emite ningún evento de texto de intro/explicación (o el builder `buildIntroText` ya no existe — aserción por `typeof` o import fallido, elegir según la decisión de eliminación).
- [x] Test del shape de `GET /api/session/:id`: sin `intro`/`explainLine` (o `null` si se eligió compat), con `fullLine` presente.
- [x] `npm test` y `npm run check` verdes.

## Checklist de verificación (pre-merge)

- [ ] Nueva sesión → primer audio = la pregunta (grabar/comparar; sin "Welcome to your practice session…").
- [ ] Tras la respuesta modelo → primer audio del loop = primer fragmento (sin "Now let's practice…"); el fragmento se **resalta visualmente** igual que antes.
- [ ] Antes de la respuesta completa → **sí** se oye `fullLine` (regresión verificada).
- [ ] Reanudar sesión (resume) → entra directo en la pregunta/fragmento pendiente, sin locuciones extra ni doble lectura.
- [ ] "Hacer otra práctica" y "Siguiente pregunta" (107) → también arrancan sin intro.
- [ ] No queda texto huérfano: `grep -rn "Welcome to your practice\|Now let's practice" src/ public/` sin resultados activos (salvo docs/specs).
- [ ] Estados UI: no hay pantalla vacía ni orb en fase fantasma al entrar; el dock queda coherente con "esperando turno" (111) una vez leída la pregunta.
- [ ] Flujo completo manual de una pregunta entera (pregunta → modelo → fragmentos con chime → full → cierre) sin frases de apertura en ningún punto.
- [ ] `CU2.md` actualizado (pasos 1 y 6 + tabla de interpretación) y señalado en el PR.

## Fuera de alcance

- Cambiar `buildFullLine` o el resto de líneas del coach (feedback/fallo/no-speech).
- Hints visuales de dinámica para usuarios nuevos (extensión futura documentada).
- Modificar la generación LLM de preguntas (`generateFirstQuestion`) o la respuesta modelo.
- El modal "Iniciando Sala de Audio" de CU1 (se conserva; es UI, no locución).

## Extensión futura (documentada, NO implementada aquí)

- **Hint visual no hablado de dinámica** en la primera sesión del perfil (chip/banner "Escucha → mantén espacio → suelta para evaluar"), que sustituya la explicación hablada sin penalizar a usuarios recurrentes.

## Recursos

- `src/lib/practice/karaoke.ts`, `src/server.ts` (`GET /api/session/:id`), `public/ui/practice-view.js` (`runFlow`, `runQuestionLoop`), `tests/karaoke.test.ts`, `spec/use-cases/CU2.md`, `spec/features/105-karaoke-practice-cu2/spec.md`.
