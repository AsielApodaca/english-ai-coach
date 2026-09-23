# 106 · Word timestamps — coloreado palabra a palabra

**Estado:** done ✅ (ola 2)

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

- [x] **Modo palabra:** `whisper-cli -f <wav> -oj -ml 1` (o `--output-json --max-len 1`) → `words: [{ word, start, end }]`. `src/lib/whisper.ts` gana `transcribeWords(wav) → Word[]` (+ `parseWhisperWordsJSON` puro, tolerante a los shapes `segments`/`timestamps`/`offsets` de whisper.cpp; los `timestamps` se prefieren y los `offsets` se tratan como ms).
- [x] `/api/transcribe` acepta flag `words=true` (query) y responde `{ text, words[], error? }`.
- [x] **Alineamiento determinista** `alignWords(spoken: Word[], target: string) → AlignedWord[]` en `src/lib/align.ts`:
  - LCS ponderada (exact/near/partial) mapea spoken→target; cada token se reclama una sola vez (palabras repetidas no se duplican).
  - token que aparece en target → **green** (match exacto normalizado); desviación leve (edit-dist ≤1, transposición, n-gram compartido) o contracción parcial → **amber**; palabra objetivo no hablada (missing) o token no esperado (extra) → **red** (los extras se anexan al final de `words[]` con sus timestamps).
  - macro: score = round(100 × matched/green+amber sobre palabras objetivo) para el fragmento.
- [x] **Merge con feedback LLM:** las palabras citadas en `issues[].fix/message` (y las de categoría `pronunciation` presentes en el target) fuerzan `amber` vía `forcedAmberWords` (preciso mientras 004 no exista).
- [ ] **Animación sincronizada:** *entregada por la ola 4 (feature 105)* — esta ola provee el motor y el modelo de datos (`words[]` con `startMs/endMs` persistidos en `attempts[].words`) que la vista karaoke consume; el render/pintado+play del intento vive en la UI de 105 (la vista `#/practice` es placeholder).
- [ ] Fallback sin whisper: mismo atributo de 105 — lo que `001` ya hace (matching de texto sobre el transcript del browser, `matched/missing/extra`) pintando green/red sin timestamps. Documentado para la UI karaoke.
- [x] **Escape de words meta:** números/contracciones se normalizan (reusa `normalize` de `practice.ts`) antes del match; contraction hablada expandida → green, mitad → amber.

## Requerimientos no funcionales

- Costo: un `whisper-cli -f word.json` por intento; el audio evaluado no se re-transcribe al reanudar porque `words[]` queda persistido en el intento.
- `words[]` (con `startMs/endMs` opcionales) guardado en `attempts[].words` (102) para no depender de re-transcripción al reanudar.

## Decisiones de diseño / tecnología

- Alineamiento propio (sin deps): normalización (reusa `normalize`/`tokenize` de `practice.ts`) + LCS ponderada (~260 líneas puras, testeable) sobre sub-tokens normalizados.
- El flujo consolidado en un endpoint: `/api/attempt` (audio raw) → transcribe `transcribeWords` → `/api/evaluate` (score+issues) → `alignWords` server-side → devuelve `{ text, words[], matched, missing, extra, score, issues, verdict, next, tips, provider }`. 105 lo usa directo.
- Ambar vs rojo: `match normalizado` ⇒ green; `edit-dist ≤1 | transposición | shared n-gram | issue fn (forcedAmberWords)` ⇒ amber; `missing`/`extra` ⇒ red.
- Desviación de diseño registrada: en el endpoint consolidado, el score persistido es el de `align` (coherente con el coloreado de palabras), en lugar del macro mixto de `001`; `/api/evaluate` conserva su comportamiento original.

## Dependencias

- 002 (whisper-cpp instalado). Consume `001` (evaluate) y la expone a 105. 102 guarda `words[]`.

## Criterios de aceptación

- [x] `transcribeWords` devuelve timestamps válidos cuando whisper-cpp está presente (validado con fixtures reales de `whisper-cli -oj -ml 1`); fallback a token único con texto completo cuando el JSON no tiene words.
- [x] Unit tests `tests/align.test.ts`: casos green/amber/red, missing, extra, contracciones, palabras repetidas, transposición de orden, forcedAmberWords (19 tests) + `tests/whisper-words.test.ts` (7 tests, parsing de shapes).
- [x] `attempt` (endpoint `/api/attempt`) consolida `{ text, words[], score, issues, ... }`; el score por palabra es coherente con el score del fragmento (test property: score === round(100 × (green+amber)/targetWords)).
- [x] `npm test` (90 pass, 0 fail) y `npm run check` verdes.

## Extensión futura (documentada, NO implementada aquí)

- **Coloreado en tiempo real exacto:** streaming de timestamps de silent/apertura de mic + alineador incremental por ventana + render por palabra al llegar del onSpeechResults (stopping no indispensable). Requiere otro motor STT (o whisper en streaming) + gestor de timeline; impacto de latencia ≠. Se documenta para no romper el MVP.

## Recursos

- `src/lib/whisper.ts`, `src/server.ts`, `tests/wordmatch.test.ts` (matching base a ampliar/reemplazar) y `spec/use-cases/CU2.md`.