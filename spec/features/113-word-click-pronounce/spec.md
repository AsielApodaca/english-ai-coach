# 113 · Click en palabra → escuchar su pronunciación

**Estado:** especificado 📋 (ola 7 — pendiente de implementar)

## Contexto

- Caso de uso: CU2, pasos 4–8 (el usuario mira la letra antes/durante la práctica y quiere oír cómo se pronuncia una palabra concreta).
- Pantallas: letra karaoke (`../../design/screens.md` §2), botón de micrófono/dock (`../../design/design-system.md`).
- Base:
  - `public/ui/practice-view.js` — `buildLine()` (spans `.kw` con `data-word`), `speak()` / `speakWithKaraoke()` y `BrowserTTS`.
  - `public/speech/browser-tts.js` — capa server `/api/tts` → fallback `speechSynthesis`.
  - `src/server.ts` — `GET /api/tts` (límite 1000 chars, rate clamp 0.5–2).
- Decisiones registradas (sesión de especificación):
  - **Click simple = pronunciar** la palabra (la selección múltiple es por arrastre — feature 112).
  - **Mientras el coach habla (karaoke en curso) o mientras graba el usuario (PTT, 111), las palabras no son clickeables ni tienen hover** (sin popover, sin audio).

## Qué hace

Al hacer **click simple** sobre una palabra de la letra karaoke, la app **reproduce la pronunciación de esa palabra** usando la cadena TTS existente, para que el aprendiz oiga la palabra aislada sin salir de la práctica. Es el equivalente al "tap para oír" de los diccionarios.

## Por qué

La pronunciación es el núcleo del producto (CU2) y la letra en pantalla no emite sonido por sí sola. Escuchar una palabra concreta bajo demanda —sin esperar a que el coach la lea— refuerza la asociación grafía↔sonido y resuelve dudas puntuales (p. ej. palabras marcadas ámbar/rojo en evaluaciones previas).

## Requerimientos funcionales

- [ ] **Disparador:** `click` sobre `.kw` (o sobre su `.kw-wrap`) reproduce `dataset.word` (token de la palabra) vía la cadena TTS.
- [ ] **Cadena de audio:** usar `GET /api/tts?text=<palabra>&rate=<tempoActual>` con el mismo `rate` del dock (tempo 0.75/1/1.25) y volumen del coach, reproduciéndola con la capa existente (`BrowserTTS` capa server, con fallback `speechSynthesis` si el server devuelve 503). No inventar un tercer canal de audio.
- [ ] **Palabra sin contexto:** se sintetiza el **token exacto** de la palabra (respetando `data-word`; si el token es una contracción p. ej. `don't`, se sintetiza tal cual).
- [ ] **Gate de habilitación (decisión registrada):** el click **solo tiene efecto** cuando el coach **no** está hablando y **no** hay captura activa:
  - Coach leyendo (fragmento/modelo/full): click y hover **sin efecto** (no popover de 112, no audio, no interrupción de la lectura ni del karaoke).
  - Grabando (PTT presionado): click sin efecto.
  - Habilitado: espera de turno, review de sesión completada, panel de cierre.
  - Implementación sugerida: clase/flag de estado en el contenedor del libro (`data-interactive="on|off"`) que gate-ee los listeners de 112 y 113 en un solo punto.
- [ ] **No desincroniza el flujo:** el click **nunca** emite eventos de la máquina de estados (no `TTS_END`, no avance de fase, no cancelación de turno). Es un side-effect aislado del flujo de práctica.
- [ ] **Locución del coach en curso:** si el usuario clicka mientras el coach habla… **no puede pasar** por el gate anterior (deshabilitado). Documentar la defensa: el listener verifica el gate **dentro** del handler (no solo CSS `pointer-events`), para que ni un race de timing ni un click programático disparen audio.
- [ ] **Colisión con selección (drag):** distinguir click de arrastre con umbral de movimiento (p. ej. ≤ 5 px y < 400 ms desde `pointerdown` → click; si supera, es selección → la 112 maneja el popover y **no** se reproduce audio). El `click` nativo ya no dispara si hubo selección de texto arrastrada — verificar el comportamiento y definir el umbral como constante testeable.
- [ ] **Colisión con popover (112):** el hover abre el popover; el click sobre la palabra reproduce el audio **y mantiene** abierto el popover (el usuario quiere oír mientras lee el significado). Si el click fuera sobre el propio popover, no pronuncia (el popover no es la palabra).
- [ ] **Un click = una síntesis:** clicks rápidos sucesivos sobre la misma u otra palabra **reemplazan** la reproducción en curso (cancelación por generación, misma semántica que `_gen` de `BrowserTTS`), no se encolan ni se superponen.
- [ ] **Sin interrupción del resto:** si mientras suena la palabra clickada el coach arranca una lectura por cambio de fase, la lectura del coach tiene prioridad: cancela la palabra aislada (no debe haber dos audios del coach a la vez).
- [ ] **Degradado:** si `/api/tts` falla (503/sin red), fallback `speechSynthesis` como hoy hace `BrowserTTS`; si tampoco hay motor, silencio sin errores visibles (la UI no muestra modales por esto).

## Requerimientos no funcionales

- Latencia de reproducción: caché de TTS si existe (compartida con 114) — un click repetido sobre la misma palabra responde casi instantáneamente.
- Cero dependencias nuevas; sin cambios de contrato en `/api/tts`.
- El ebook/karaoke no debe re-renderizarse al clickar (solo side-effect de audio).

## Decisiones de diseño / tecnología

- **Click = audio, arrastre = selección** (decisión del usuario): resuelve el conflicto 112↔113 sin modifiers (no shift ni ctrl). Umbral de 5 px/400 ms como separación.
- **Gate "coach hablando / grabando" en handler, no solo en CSS:** decisión explícita del usuario ("mientras el coach habla, las palabras no deben ser clickeables, osea, no deben tener efecto hover"); el CSS `pointer-events` es la primera línea, el check de estado en el handler la segunda.
- **Reutilizar `BrowserTTS`** en vez de `<audio>` dedicado: ya resuelve rate server-side, volumen vivo y cancelación.
- **Side-effect aislado:** deliberadamente fuera de `cu2.ts` (el reducer no se entera) — el reducer solo modela el flujo de práctica, no el audio casual.

## Dependencias

- 112 (popover) — comparte el gate de interacción y el modelo de eventos del span; implementar el gate de forma compartida (una sola fuente de verdad).
- 111 (PTT) — define el estado "grabando" que desactiva la interacción.
- 114 (calidad TTS) — si llega la caché de síntesis, este click la aprovecha.
- 007/001 — cadena TTS existente.

## Criterios de aceptación

- [ ] `tests/word-click.test.ts` (o ampliación del módulo de gate): lógica pura de `isClick vs drag` (umbral px/tiempo), evaluación del gate (coachSpeaking × recording → blocked; idle/review → allowed), y que el handler de click no emite eventos de fase (spy sobre el dispatcher). *La parte DOM se valida manualmente (no hay harness de DOM en el repo).*
- [ ] `npm test` verde y `npm run check` verde (ficheros nuevos listados).

## Checklist de verificación (pre-merge)

- [ ] Click en una palabra durante la **espera de turno** → se escucha exactamente esa palabra, con el tempo y volumen actuales del dock.
- [ ] Mientras el coach lee el fragmento/modelo/full → click **no** emite audio, no abre popover, no corta la lectura ni desordena el karaoke.
- [ ] Durante la captura PTT (botón/espacio mantenido) → click sin efecto.
- [ ] Dos clicks rápidos en palabras distintas → solo se oye la última (sin solapes).
- [ ] Arrastrar sobre 2+ palabras → **no** reproduce audio; abre el popover del conjunto (112).
- [ ] Click en palabra → popover del hover sigue visible mientras suena el audio.
- [ ] Click en review mode (sesión completada) → funciona igual.
- [ ] Sin servidor TTS (engine null/503) → fallback al motor del navegador o silencio, sin error en consola/UI.
- [ ] Regresión: coloreado, `.kw-spoken`, `scrollIntoView` y selección nativa de texto intactos.
- [ ] Click programático/`fireEvent` con coach hablando → bloqueado por el gate del handler (no solo por CSS).

## Fuera de alcance

- Reproducir la frase/selección completa (extensión futura: click en popover → oír la frase).
- Reproducir el fragmento entero al click en la línea (hoy existe diseño para "línea future clicable" en `design-system.md` — fuera de este alcance).
- Grabar y comparar la voz del usuario con la del coach.
- Popover de 112 (feature separada, solo se define la convivencia).

## Recursos

- `public/ui/practice-view.js` (`buildLine`, `speak`, `speakWithKaraoke`), `public/speech/browser-tts.js`, `src/server.ts` (`GET /api/tts`), `tests/`, `spec/use-cases/CU2.md`, `spec/design/design-system.md`.
