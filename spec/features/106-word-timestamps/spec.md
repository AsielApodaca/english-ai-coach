# 106 · Word timestamps — coloreado palabra a palabra

**Estado:** planificado 🔜 (ola 2)

## Contexto

- Caso de uso: CU2, pasos 10 y 17 (coloreado de lo que dijo el usuario, post-grabación).
- Pantallas: karaoke (`screens.md` §2 y design-system § componente 1).
- Base: `src/lib/whisper.ts` (transcripción por línea, sin timestamps) y `src/server.ts` (`/api/transcribe`).
- Decisión registrada: el **coloreado es post-grabación con animación sincronizada**; el marcado en tiempo real exacto es objetivo futuro documentado (ver extensión abajo).

## Qué hace

Permite pasar del rótulo "score por fragmento" a **colores por palabra** sobre la línea karaoke del usuario tal como el diseño lo muestra (verde/ámbar/rojo, CU2 p10/p17). Al soltar el micrófono, el server transcribe la grabación con **word-level timestamps** de whisper.cpp y alinea contra el fragmento objetivo; el frontend pinta cada palabra del objetivo según el resultado y anima el pintado sincronizado a la reproducción del audio grabado del usuario.

## Por qué

El color por palabra da feedback granular (dónde exactamente falló) y hace el "karaoke" un instrumento de corrección, no solo de lectura. Whisper.cpp emite timestamps por token ya; falta su consumo y el alineamiento determinista (green/amber/red) — casa con la feature `004` para subir precisión `amber`.

## Requerimientos funcionales

- [ ] **Modo palabra:** `whisper-cli -f <wav> -oj -ml 1` (o `--output-json --max-len 1`) → `words: [{ word, start, end }]`. `src/lib/whisper.ts` gana `transcribeWords(wav) → Word[]`.
- [ ] `/api/transcribe` acepta flag `words: true` y responde `{ text, words[], error? }`.
- [ ] **Alineamiento determinista** `alignWords(spoken: Word[], target: string) → AlignedWord[]` en `src/lib/align.ts`:
  - busca de subsecuencia (LCS/window) para mapear spoken→target.
  - token que aparece en target → **green** (match exacto normalizado); token con desviación leve (edit-distance 1 o trasposición) → **amber**; palabra objetivo no hablada (missing) o token no esperado (extra) → **red**.
  - macro: score = matches/targetWords*(100) para el fragmento (reusa cuantile de `001`).
- [ ] **Merge con feedback LLM:** las `issues[].fragments`/palabras señaladas por el evaluador (pronunciación) fuerzan `amber` en palabras match-plain (precisa mientras 004 no exista).
- [ ] **Animación sincronizada:** tras el upload, `#/practice` pinta palabras con color y al hacer play del intento (grabación) ilumina palabra a palabra con `start/end` (CSS `highlight::step` por temporizador requestAnimationFrame). botón "reproducir intento".
- [ ] Fallback: si whisper no está → lo que `001` ya hace (matching de texto sobre el transcript del browser, extrae `matched/missing/extra`) pintando green/red sin timestamps (sin animación por-word; se ilumina la línea completa).
- [ ] **Escape de words meta:** números/contracciones se normalizan (canonicalize, plurales leves) antes del match.

## Requerimientos no funcionales

- Costo: un `whisper-cli -f word.json` por intento; cachear el audio ya evaluado (no re-transcribe).
- `words[]` guardado en `attempts[].words` (102) para no depender de re-transcripción al reanudar.

## Decisiones de diseño / tecnología

- Alineamiento propio (sin deps): normalización + LCS leve (~40 líneas puras, testeable) sobre tokens.
- El flujo completo queda: grabador (browser) → `/api/transcribe?words` → `/api/evaluate` (score+issues) → `alignWords` server-side → devolver `{ words[] , score , issues }` en un solo endpoint `/api/attempt` consolidado (105 lo usa).
- Ambar vs rojo: `match normalizado` ⇒ green; `edit-dist 1 | issue fn | n-gram overlap<1 pero>0` ⇒ amber; `missing/extra` ⇒ red.

## Dependencias

- 002 (whisper-cpp instalado). Consume `001` (evaluate) y la expone a 105. 102 guarda `words[]`.

## Criterios de aceptación

- [ ] `transcribeWords` devuelve timestamps válidos cuando whisper-cpp está presente; fallback claro.
- [ ] Unit tests `tests/align.test.ts`: casos green/amber/red, missing, extra, contracciones.
- [ ] `attempt` consolida `{ text, words[], score, issues }`; el score por palabra es coherente con el score del fragmento (test property: nº greens ≈ score).
- [ ] `npm test` y `npm run check` verdes.

## Extensión futura (documentada, NO implementada aquí)

- **Coloreado en tiempo real exacto:** streaming de timestamps de silent/apertura de mic + alineador incremental por ventana + render por palabra al llegar del onSpeechResults (stopping no indispensable). Requiere otro motor STT (o whisper en streaming) + gestor de timeline; impacto de latencia ≠. Se documenta para no romper el MVP.

## Recursos

- `src/lib/whisper.ts`, `src/server.ts`, `tests/wordmatch.test.ts` (matching base a ampliar/reemplazar) y `spec/use-cases/CU2.md`.