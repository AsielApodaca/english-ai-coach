# 005 · Vocabulario técnico (repaso espaciado) — Tareas

## Núcleo (`src/lib/cards.ts`)

- [ ] Tipos `Card { word, category, definition, example, prompt, ease, intervalDays, dueAt, reviews }`.
- [ ] `dueCards(cards, now)`: filtrar vencidas ordenadas por `dueAt`.
- [ ] `applyReview(card, correct)`: SM-2 simplificado (fail → 1d/descuento ease; correct → ×ease, top 30d).
- [ ] `syncCardsFromProfile(profile, cards, candidates)`: crear tarjetas para `vocabGaps` nuevos (LLM generar, 1 llamada por palabra), sin duplicar; soportar descarte (gap ignorado 90d).
- [ ] Prompt de generación JSON estricto reusando `chatJSON`/`extractJSON`.

## Storage

- [ ] `data/cards.json` en `createStorage`: `loadCards()`/`saveCards()` (patrón atómico existente), fuera de git.

## Server

- [ ] `GET /api/cards` → `{ due: Card[] }` (máx 3, más vencidas).
- [ ] `POST /api/cards/review` `{ id, correct }` → aplicar SM-2, persistir, responder próximo intervalo.
- [ ] Hook en `persistAttempt`/session save: `syncCardsFromProfile()` tras actualizar perfil.

## UI

- [ ] Sección "Due vocabulary" en inicio cuando hay tarjeta vencida.
- [ ] Práctica hablada de tarjeta (fragmento corto + TTS/STT, reusa flujo 001); acierto = score ≥70.
- [ ] Fallback self-report ("I knew it / I didn't") para revisión silenciosa.
- [ ] Descartar tarjeta (tool en la UI) → gap ignorado 90d.
- [ ] Aviso "Next review in X days".

## Tests / cierre

- [ ] Tests `node:test`: `applyReview`, `dueCards`, `syncCardsFromProfile` (nuevos, sin duplicados), `loadCards`/`saveCards`.
- [ ] Validar contra criterios de aceptación de spec.md.
- [ ] Mover la feature a "Hecho" en `../../constitution/roadmap.md`.