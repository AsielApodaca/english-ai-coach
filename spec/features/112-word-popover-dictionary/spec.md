# 112 · Popover léxico: hover en palabra y selección múltiple

**Estado:** done ✅ (implementado en rama `feature/word-popover-dictionary`, review aprobado; checklist manual pre-merge pendiente de verificación en browser)

## Contexto

- Caso de uso: CU2, pasos 4 y 7 (la respuesta karaoke permanece en pantalla durante toda la práctica) — lectura comprensiva del usuario entre turnos.
- Pantallas: letra karaoke (`../../design/screens.md` §2; `../../design/design-system.md` — intención registrada: "IPA inspector" panel derecho, chips bajo palabras; línea `future` interactiva).
- Base:
  - `public/ui/practice-view.js` — `buildLine(index, text)` construye un `<span class="kw-wrap">` por palabra con `<span class="kw" data-word="…">`; `renderKaraokeBook()`, `rebuildBook()`, `colorWords()`, `coloredWords()` (review mode). **Hoy no existe ningún listener sobre `.kw`.**
  - `public/ui/karaoke-color.js` — `tokenizeWords()` (puro, testeado).
  - `public/styles.css` — `.kw`, `.kw-wrap`, `.kw-green/amber/red`, `.kw-spoken`.
- Decisiones registradas (sesión de especificación):
  - Fuente de datos: **dictionaryapi.dev (definición/ejemplo EN) + MyMemory (traducción ES) + LLM como fallback** (para phrasal verbs, selecciones y cuando las APIs fallan).
  - Interacción: **hover → popover de la palabra**; **arrastrar sobre varias palabras → popover del conjunto**; **click simple → pronunciación** (implementado en la feature 113, separada).

## Qué hace

Al pasar el cursor sobre una palabra de la letra aparece un **recuadro pequeño (popover)** con tres campos: **significado** (definición breve en inglés), **ejemplo de uso** y **traducción al español**. Si el usuario **arrastra el cursor seleccionando varias palabras**, aparece el **mismo recuadro aplicado al conjunto**, resolviendo expresiones cuyo significado global difiere de la suma de las partes (p. ej. `shut` = "cerrar", `up` = "arriba", pero `shut up` = "callarse la boca" / "cállate").

## Por qué

El aprendiz se topa con vocabulario y phrasal verbs durante la práctica; salir de la app a buscar una palabra rompe la inmersión y el ritmo. El popover *in situ* convierte cada sesión en lectura incidental de vocabulario, y la selección múltiple cubre el caso de las expresiones idiomáticas, que es justamente donde un diccionario palabra a palabra falla.

## Requerimientos funcionales

### Popover de palabra individual (hover)

- [x] **Disparador:** `mouseenter`/`pointerover` sobre `.kw` con delay de intención (~300 ms; cancelar si el cursor sale antes). Aplicar solo en punteros con hover real (`@media (hover: hover)` — en touch, el popover se abre por selección de texto, ver más abajo).
- [x] **Contenido del recuadro** (3 campos visibles, en este orden):
  1. **Significado** — definición breve EN (primera definición de la entrada, recortada a ~140 chars).
  2. **Ejemplo de uso** — frase de ejemplo EN con la palabra en contexto.
  3. **Traducción ES** — equivalente en español.
- [x] **Posicionamiento:** recuadro flotante anclado a la palabra (preferir arriba; si no cabe en el viewport, abajo; centrado sobre la palabra con clamp a los bordes). No debe ocultar la línea actual del karaoke ni provocar scroll.
- [x] **Cierre:** `mouseleave` del popover (con gracia de ~150 ms para permitir moverse hacia él), click fuera, cambio de fase de flujo, inicio de captura (PTT, 111), o `Escape`.
- [x] **Feedback de carga:** si la respuesta tarda > ~200 ms, mostrar estado "cargando…" dentro del recuadro (skeleton de 1–2 líneas); nunca bloquear la UI ni el flujo del coach.

### Selección múltiple (arrastre)

- [x] **Disparador:** selección nativa del navegador sobre los spans (el usuario **arrastra el cursor** sobre varias palabras) → al `mouseup`, si `window.getSelection()` contiene **≥ 2 tokens** dentro del karaoke (o dentro de `.review-words`), se abre el popover **del conjunto**.
- [x] **Normalización del conjunto:** extraer el texto seleccionado en orden, unificar espacios, quitar puntuación de borde; respetar el span de líneas contiguas (selección multi-línea válida si las líneas son adyacentes en el mismo libro karaoke).
- [x] **Contenido:** mismos 3 campos aplicados a la frase completa (significado global, ejemplo de la frase, traducción ES de la frase) — p. ej. `shut up` → "tell someone to stop talking — Cállate / Cállate la boca".
- [x] **Una sola palabra seleccionada (drag de 1 token):** se trata como palabra individual (mismo pipeline).
- [x] **Sustituye al popover individual:** si hay selección activa, el hover individual no muestra popover hasta que la selección se limpie.
- [x] **Touch:** en dispositivos sin hover, la selección de texto (long-press + arrastre) abre el popover del conjunto; el popover de palabra suelta en touch queda documentado como extensión mínima (ver Fuera de alcance: click-to-speak es 113).

### Fuente de datos y pipeline

- [x] **Endpoint server:** `GET /api/lookup?text=<frase>` → `{ ok: true, kind: "word"|"phrase", source: "dictionary"|"mymemory"|"llm"|"cache", entry: { gloss, example, translationEs } }` o `{ ok: false, error }`. Server-side para: no exponer claves LLM, evitar CORS, y compartir caché.
- [x] **Pipeline de resolución** (paradas en el primer éxito, cacheado):
  1. **Caché** (cliente y servidor) por texto normalizado → respuesta inmediata.
  2. **Palabra simple** → `dictionaryapi.dev` (`GET https://api.dictionaryapi.dev/api/v2/entries/en/<word>`) para `gloss` (primera definición) y `example`.
  3. **Traducción ES** → MyMemory (`https://api.mymemory.translated.net/get?q=<text>&langpair=en|es`) para el campo `translationEs`.
  4. **Fallback LLM** — se usa cuando: es un **conjunto de ≥ 2 palabras**, o el diccionario no resolvió la palabra (404/rara), o MyMemory falló, o el resultado es inconsistente. Prompt corto con salida estricta `{"gloss","example","translationEs"}` + extracción robusta de JSON (convención del proyecto: tolerar code fences/ruido), usando la **misma cadena de providers con fallback** (registry de 001).
- [x] **Caché obligatoria:** cliente `Map` en memoria + `localStorage` (clave `engcoach.lookup.<normalized>`, con límite de entradas p. ej. 500); servidor `Map` en memoria (LRU simple) para no repetir llamadas externas en cada hover. TTL: entradas buenas indefinidas (contenido léxico estable); errores **no** se cachean como éxito.
- [x] **Límites:** `text` ≤ 60 chars, normalizado (minúsculas, sin signos de borde) antes de consultar; rechazar textos que no sean tokens del karaoke (no es un endpoint de traducción libre).
- [x] **Errores y modo degradado:** si todo falla → popover con mensaje breve tipo "Significado no disponible" (sin stack traces, sin modales de error, sin reintentos en bucle — máx. 1 reintento con backoff corto). El flujo de práctica **nunca** se bloquea o rompe por un lookup.
- [x] **Costo $0:** dictionaryapi.dev y MyMemory son gratuitas sin key (MyMemory con límite diario ~5k palabras — la caché es la mitigación); el LLM solo en cache-miss de fallback (free tier existente). Sin dependencias npm nuevas.

### Habilitación e integración con el flujo

- [x] **Habilitado cuando:** el coach **no** está hablando y **no** hay captura activa (PTT, 111) — es decir: en la espera de turno del usuario, en review de sesión completada, y en el panel "hacer otra práctica". **Deshabilitado** (sin hover ni popover) mientras el coach lee (karaoke en curso) o mientras graba.
- [x] El popover no interfiere con: el coloreado `.kw-green/amber/red`, la animación `.kw-spoken`, `scrollIntoView` de línea activa, la selección nativa para copiar, ni el `data-word` usado por 113.
- [x] Mismo comportamiento en **review mode** (`.review-words`) y en el libro de respuesta modelo, no solo en la línea activa.

## Requerimientos no funcionales

- Latencia percibida: caché hit < 50 ms; miss con red ~300–800 ms con estado de carga visible.
- El popover es un único nodo DOM reutilizado (no un nodo por palabra) — sin memory leaks al reconstruir el libro (`rebuildBook`).
- Estética conforme a `design-system.md` (tokens existentes: superficie, borde, radius, tipografía `label/body`); sin fonts ni assets nuevos.

## Decisiones de diseño / tecnología

- **Endpoint server vs client directo:** server elegido (privacidad de la key del LLM, CORS, caché compartida). Alternativa descartada: fetch directo del browser a dictionaryapi.dev/MyMemory (expone el patrón de fallback al cliente y no comparte caché).
- **Resolución híbrida (dict + MyMemory + LLM):** decisión del usuario tras detectar la inconsistencia de que **dictionaryapi.dev no traduce al español** (solo EN→EN). El LLM cubre phrasals/selecciones y huecos; la caché cubre el costo.
- **Arrastre nativo (selección) como disparador de multi-palabra:** elegido sobre shift/ctrl+click (menos fricción, respeta el hábito de selección de texto del navegador). El arrastre distingue de un click simple, que corresponde a 113.
- **Un solo endpoint `lookup`** en vez de dos (una por palabra/frase): mismo pipeline, el server decide `kind` por número de tokens.

## Dependencias

- 105 (render de `buildLine`/libro karaoke y review) — los hooks de evento se montan sobre su DOM.
- 111 (PTT) — define las ventanas habilitadas/deshabilitadas de interacción.
- 113 (click → pronunciar) — conviven: hover/arrastre → popover; click simple → audio.
- 001 (registry de providers LLM) — fallback del pipeline.

## Criterios de aceptación

- [x] `tests/lookup.test.ts` (nuevo, puro + fetch fake):
  - parser del JSON de dictionaryapi.dev (fixture real) → `gloss`/`example`;
  - normalización de la frase seleccionada (espacios, puntuación, multi-línea);
  - selección de pipeline: word→dict, phrase→LLM, dict-404→LLM, MyMemory-fail→LLM;
  - prompt del LLM + extracción de JSON tolerante a code fences;
  - caché: hit no llama al provider (spy), errores no se cachean como éxito;
  - LLM caído → `{ ok: false }` sin excepción.
  - Caso obligatorio: `shut up` → resolución vía LLM con `translationEs` no literal ("cerrar" + "arriba" **no** es aceptable).
- [x] `npm test` en verde y `npm run check` verde (ficheros nuevos agregados a la lista `check`).

## Checklist de verificación (pre-merge)

- [ ] Hover sobre palabra → popover con los 3 campos, posiciones arriba/abajo según espacio, sin tapar la línea activa.
- [ ] Arrastrar `shut` + `up` → popover del conjunto con significado global correcto.
- [ ] Arrastrar una sola palabra → popover individual idéntico al del hover.
- [ ] Click fuera / `Escape` / sacar el cursor → el popover cierra (sin pops de error si no había red).
- [ ] Sin conexión: popover degrada a "Significado no disponible", la sesión sigue funcionando.
- [ ] Segunda vez que se consulta la misma palabra (recarga incluida) → respuesta instantánea desde caché (verificar en Network: sin llamadas).
- [ ] Durante la lectura del coach: hover **no** muestra popover; durante la captura PTT: tampoco.
- [ ] En review de sesión completada: hover y selección funcionan igual.
- [ ] El coloreado de palabras y la animación karaoke no cambian (regresión visual).
- [ ] Límite MyMemory respetado por caché: realizar 10 hovers repetidos → ≤ 1 llamada externa por texto.
- [ ] `text` con más de 60 chars o texto arbitrario → rechazo limpio (`ok:false`), sin petición externa.

## Fuera de alcance

- Pronunciación al click (feature 113).
- Guardar palabras en el deck de vocabulario (feature 005).
- Popover sobre el subtítulo de la pregunta del coach (fuera del libro karaoke) — posible extensión futura.
- Offline completo del diccionario (CMUdict/diccionario empaquetado) — ver backlog de fuentes fonéticas en el roadmap.
- Modo touch de hover para palabra suelta (solo selección en touch).

## Recursos

- `public/ui/practice-view.js` (`buildLine`, `renderKaraokeBook`, review `coloredWords`), `public/ui/karaoke-color.js`, `public/styles.css`, `src/server.ts` (nueva ruta `/api/lookup`), `src/lib/` (nuevo módulo puro de pipeline/caché, testeable), `tests/lookup.test.ts`, `spec/design/design-system.md`.
