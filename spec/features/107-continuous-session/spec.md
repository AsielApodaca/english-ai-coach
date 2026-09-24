# 107 · Sesión continua Q1→Q∞ con dificultad adaptativa

**Estado:** implementado ✅ (ola 5)

## Contexto

- Caso de uso: CU2 (base por pregunta, extendido por el diseño al flujo continuo).
- Pantallas: `live-practice.html` — "Flujo Continuo de Preguntas" (badge "ACTIVA (Q1)"), `screens.md` §2.
- Depende de 105 (práctica por pregunta).

## Qué hace

Convierte la práctica de una pregunta en **sesión de práctica continua**: el sistema mantiene la conversación viva de pregunta en pregunta (Q1, Q2, … Q∞) con la misma sesión v2, hasta que el usuario dice "Finalizar Sesión" o hace un cierre explícito ("Siguiente Pregunta" por pedido o auto-advance según settings). La dificultad se adapta al desempeño (rigor/ritmo suben si las últimas 3 respuestas superan el objetivo; bajan si el desempeño decae) y hay tiempo de preparación configurable (0/3/5 s con beep) antes de que el coach lea el modelo.

## Por qué

El diseño (screen 2) explicita Q1→Q∞ para simular una entrevista/standup completa sin reiniciar la sesión; el roadmap determina que CU2 + adaptativa son el producto central (no una práctica de una pregunta). Reutiliza todo el pipeline de 105 por pregunta; solo cambia la orquestación y persistencia por pregunta.

## Requerimientos funcionales

- [x] **Loop de preguntas:** al terminar la fase DONE de 105, la UI ofrece "Siguiente Pregunta (IA)"; si `autoAdvance` (108) está activo, pasa automáticamente tras el feedback.
- [x] `POST /api/session/next-question { sessionId }` → genera Q_n+1 (variando subtopic dentro del topic; sin repetir preguntas) y reinicia el loop CU2 en `#/practice/<id>`. El `questions[]` de la sesión (102) persiste cada pregunta completada.
- [x] **Adaptativa** (`config.settingsSnapshot.adaptive` de 108):
  - precedente: mantener `rollingScores` (últimos 3 scores de full-answer con eval).
  - si `avg(últimas 3) >= threshold.up` (default 90): subir nivel y/o rigor (B1→B2…, clamps independientes).
  - si `avg < threshold.down` (default 65): bajar.
  - el cambio informa al usuario: pill "Dificultad sube a B2 · rigor Estricto".
- [x] **Tiempo de preparación:** 0/3/5 s (toggle en 108) — antes de que el coach lea la respuesta modelo, play de 3 beeps (o 1 en 0s); el usuario prepara. El texto del modelo no se oculta (solo pausa).
- [x] **Finalizar Sesión:** en cualquier momento → `saveSession(completed)` + pantalla de cierre con resumen: preguntas practicadas, scores, focus de mejora.
- [x] **Badge de pregunta actual:** "ACTIVA (Q{n})" en el sidebar (109 lo lee).
- [x] Guardado del contexto acumulado efectivo: `buildContextSummary` (topic + últimos N exchanges) se pasa al LLM en cada `next-question` (con memoria del aprendiz, convención tech-stack).

## Requerimientos no funcionales

- Coste LLM: cada `next-question` es una llamada; se amortiza con 1 respuesta modelo por pregunta.
- No bloquea ABA: la adaptativa cambia en el `next-question`, no en medio del fragmento.

## Decisiones de diseño / tecnología

- Reusa `src/lib/practice.ts` por pregunta; nueva pieza `src/lib/continuous.ts` (pure): `computeAdaptive(next, rolling, config) → { level, rigor, message }` (testeable sin red).
- Si el LLM no puede generar la siguiente (network), deja la sesión `active` y ofrece reintentar desde la última pregunta guardada (no pierde).

## Dependencias

- 105 (flujo por pregunta), 102 (questions[]), 108 (settings: autoAdvance, tempo, prepTime, thresholds). Se apoya en 101 (shell/layout).

## Criterios de aceptación

- [x] Con `autoAdvance` off, "Siguiente Pregunta" genera Q2…Q3 sin repetir; con on, avanza solo.
- [x] La adaptativa sube/baja según el rolling real (unit tests de `computeAdaptive`).
- [x] Finalizar en Q_n guarda `completed` con N preguntas y aparece con score agregado en historial (109).
- [x] Reanudar una sesión activa tras caída de red retoma en la última pregunta sin duplicar (idempotente: `eval===null` → devuelve la última pregunta).
- [x] `npm test` y `npm run check` verdes.

## Fuera de alcance

- Historial/reanudación UI (109). Settings UI de la adaptativa (108). IPA panel.

## Recursos

- `spec/use-cases/CU2.md`, `spec/design/screens.md` §2 (badge "ACTIVA (Q1)"), `src/lib/practice.ts`, `src/lib/learner.ts`.