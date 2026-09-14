# 005 · Vocabulario técnico (repaso espaciado) — Plan

## Enfoque

Feature pasiva: se alimenta sola de los datos que la evaluación de 001 ya produce (`computeStats` → `profile.vocabGaps`). No hace falta nueva recopilación; solo generar tarjetas a demanda, persistirlas y mostrarlas cuando vencen.

## Componentes

1. **Modelo (`src/lib/cards.ts`)**:
   - `Card { word, category, definition, example, prompt, ease (2.5), intervalDays, dueAt, reviews }`.
   - `dueCards(cards, now)` → vencidas.
   - SM-2 simplificado: `applyReview(card, correct)` — correct → `ease` fijo (o +0.1), intervalo ×ease (cap 30d); fail → intervalo 1d, ease −0.2 (piso 1.3).
2. **Storage** — nuevo `data/cards.json` (fuera de git, mismo patrón de `data/profile.json`): `createStorage` expone `loadCards()`/`saveCards()`.
3. **Generación de tarjeta (LLM)** — al detectar una palabra en `vocabGaps` sin tarjeta aún, generarla con un prompt JSON estricto (reusa `chatJSON` + `extractJSON`):
   `{ word, definition, example, prompt }` (definición en inglés técnico + ejemplo laboral + frase corta para practicar).
4. **Server (`src/server.ts`)**:
   - `GET /api/cards` → `{ due: Card[] }` (hasta 1-3, las más vencidas).
   - `POST /api/cards/review` `{ id, correct }` → aplica SM-2, persiste y devuelve el update.
   - Tras `persistAttempt` (001): `syncCardsFromProfile()` — crear tarjetas para gaps nuevos.
5. **UI**:
   - Sección "Due vocabulary" en la pantalla de inicio (arriba de Practice) cuando hay tarjeta vencida: palabra + tarjeta + botón "Practicar".
   - Al practicar: fragmento hablado corto (reusa flujo de práctica, una sola frase) + TTS/STT; el acierto se decide por la evaluación (score ≥70 = correct) o por self-report del usuario si no quiere hablar.
   - Aviso de intervalo tras revisar ("Next review in X days").
6. **Tests `node:test`**: `applyReview` (intervalos, fail resets a 1d, ease floor), `dueCards`, `syncCardsFromProfile` (crea solo gaps nuevos, sin duplicar).

## Decisiones

- **SM-2 simplificado** nota: solo los valores básicos; no se necesita la matriz de repeticiones de Anki para single-user.
- **El acierto se deriva de la práctica hablada**: coherencia con la misión (Habla primero); el self-report es el fallback silencioso.
- **Generación a demanda**: no se queman costos LLM; solo se crean tarjetas cuando hay gaps sin tarjeta (una llamada por palabra nueva).

## Riesgos

- **Costos LLM por tarjeta**: acotado a gaps nuevos; se cachea en `data/cards.json`.
- **Palabras falsas/ruido** de la transcripción (missing puede incluir palabras mal transcritas): sin curidado, genera tarjetas basura → mitigar pidiendo >1 ocurrencia (ya lo hace `computeStats`, n≥2) y permitiendo descartar tarjeta en la UI (Delete → gap se ignora por 90d).
- **Tarjetas vencidas desbordan**: límite de hasta 3 sugeridas por entrada; el resto espera.