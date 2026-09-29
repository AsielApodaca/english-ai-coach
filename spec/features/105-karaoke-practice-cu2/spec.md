# 105 · Práctica karaoke estilo Spotify (CU2)

**Estado:** implementado ✅ (ola 4)

## Correcciones de bugs y decisión de captura (2026-09)

**Decisión de UX: escucha automática (hands-free) en el turno del usuario.** Tras dos rondas de reportes ("el botón del mic se queda naranja" y "el micro se enciende pero no captura audio") se identificó la causa raíz de percepción: al empezar el turno el micrófono se pre-calentaba (indicador del SO encendido) y el orb pulsaba en verde, pero solo se grababa **manteniendo presionado** (push-to-talk) → sensación de "escucha automática que no captura" y ambigüedad sobre el estado naranja. Resuelto cambiando el flujo a escucha automática:

- **Turno del usuario:** beep de preparación → el micrófono escucha solo (sin pulsar) → el turno termina por **detección de silencio** (`VadTracker` en `public/speech/vad.js`, 1.2 s de silencio tras hablar), por guard sin habla (20 s → "I didn't hear you"), o por tope de turno (60 s para lecturas largas de respuesta completa).
- **El orb ya NO es clickeable** — es un indicador de estado: dim/gris en espera, pulso verde en "tu turno", ámbar + anillos mientras escucha, y VU en vivo. El ámbar se gestiona solo desde `setMode()` del dock (fuente única), por lo que no puede quedar pegado.
- El path de browser STT (fallback texto) también arranca solo tras el beep; el propio engine detecta el fin de habla (Web Speech).
- **Se eliminó el "tiempo de preparación" (0/3/5 s con beeps, spec 107)** que sonaba entre la pregunta y el modelo: ahí el usuario no prepara nada (solo escucha). El único beep que existe ahora es el ready-beep hands-free del turno real de captura.

**Otros fixes de audio (mantenidos):**
- `AudioContext` a 16 kHz (`new AudioContext({ sampleRate: 16000 })`, fallback a rate nativo) — whisper.cpp espera WAV 16 kHz mono. El `AudioContext` se crea por turno sin gesto: Chrome lo permite desde la primera activación de la página (el clic que inicia la práctica); si queda `suspended`, `start()` lo reanuda.
- Buffer del ScriptProcessor 4096→2048 (≈128 ms @16 kHz) para VAD/VU reactivos.
- `acquireStream()` en `recorder-wave.js` degrada al input por defecto cuando el `deviceId` guardado (`engcoach.mic`) quedó obsoleto (evita fallo silencioso).
- Browser STT no pierde captura en interacciones cortas (flag `started` en `browser-stt.js`).

## Coloreado del karaoke — flujo corregido (2026-09)

Dos bugs de coloreado reportados tras la ola 4 y corregidos en la rama `fix/karaoke-live-coloring`:

**Bug A — resaltado prematuro.** El book fijaba la línea 0 como `current` (y el resto `future` con `opacity .35 + blur`) **antes** de que el coach leyera la respuesta modelo completa; además `kw-spoken` (azul) no se limpiaba al terminar la lectura y el coach leía cada fragmento con TTS plano (sin progreso). Resultado: no se podía seguir la lectura en vivo ni del modelo ni de los fragmentos.

**Bug B — pintado fuera del fragmento.** `colorWords()` emparejaba `outcome.words` (índices **locales al fragmento/target**, ver `align.ts`) contra `allWordSpans()` (índice **global** de todo el book) ⇒ al evaluar el fragmento *k* se pintaban las **primeras N palabras de la respuesta**, y los *extras* anexados al final de `words[]` (`align.ts`, siempre `red`) caían sobre spans de otros fragmentos. `renderFeedback(outcome, lineIndex)` recibía el índice correcto pero era un parámetro muerto.

### Flujo de coloreado normativo

```
MODEL     el coach lee TODA la respuesta modelo
          → todas las líneas blancas y legibles (book en estado `reading`,
            sin atenuación ni blur) y se pintan de azul EN VIVO palabra a palabra
          → al terminar, la respuesta vuelve COMPLETAMENTE a blanco
EXPLAIN   la respuesta permanece en blanco
LOOP      por fragmento k:
            se resalta la línea k (`current`) y se opaca el resto
            → reintento: el fragmento vuelve a BLANCO antes de que el coach relea
            → el coach lee el fragmento → se pinta de azul EN VIVO SOBRE esa línea
            → al terminar el coach, el fragmento queda en BLANCO (turno del usuario)
            → cuando el usuario termina de hablar → SOLO esa línea se pinta con
              semáforo (green/amber/red); los fragmentos ya aprobados conservan
              su semáforo; el resto de la respuesta no se toca
            → si falla, su grabación se repite CON el semáforo visible
              (sin superponer azul) y luego el coach relee en blanco
FULL      al terminar todos los fragmentos se DESPINTA el semáforo de todos y
          la respuesta queda en BLANCO → el usuario lee la respuesta entera
          → al final se pinta toda la respuesta con semáforo
          → si no aprueba → vuelve a BLANCO y se reintenta (hasta aprobar)
```

Garantías:
- El semáforo solo se aplica al **rango de spans de la línea en evaluación**; los *extras* del alineador (índices ≥ número de palabras de la línea) se descartan y nunca pintan spans ajenos.
- El auto-scroll (`scrollIntoView({ block: "nearest" })`) mantiene la línea activa visible dentro del `karaoke-book` (`max-height: 46vh`).
- `src/lib/cu2.ts` no cambia: el reducer ya modelaba el reintento de fragmento y el de respuesta completa; la vista se alinea con él.

### Requerimientos de coloreado

- [x] **Estado `reading` del book** (`.karaoke-book.reading`): todas las líneas en `--text`, opacidad 1 y sin blur mientras el coach lee la respuesta modelo/explica.
- [x] **Azul en vivo parametrizado:** `speakWithKaraoke(text, token, { spans })` pinta `kw-spoken` sobre un subconjunto de spans (todo el book en MODEL, una sola línea en LOOP) y lo limpia al terminar la lectura.
- [x] **Coloreado acotado por línea:** `colorWords(outcome, lineIndex)` sólo toca los spans de esa línea y conserva el semáforo de las líneas anteriores.
- [x] **Reintento en blanco:** antes de que el coach (re)lea un fragmento se limpia su semáforo.
- [x] **Reintento de respuesta completa:** la vista repite `fullAnswer → feedback` hasta que apruebe, como ya hacía el reducer.
- [x] **Replay del WAV sin animación azul:** al fallar, la grabación del usuario se repite con el semáforo ya pintado y **visible**; `kw-spoken` no se superpone jamás sobre los colores de la evaluación. El replay se corta con la píldora "Reintentar fragmento" y al salir de la ruta (`stopReplay`).
- [x] **Helpers puros** en `public/ui/karaoke-color.js` con tests (`tests/karaoke-color.test.ts`).

## Contexto

- Caso de uso: **CU2** (`spec/use-cases/CU2.md`) — el corazón del producto.
- Pantallas: `live-practice.html` / `hidden-practice-minimalist.html` (IDs `ffb4dd13e7c44d5092d7b3b4323e2378`, `1c6af75e5fac4d13bfe531f7dc945f2f`); `screens.md` §2.
- Motores a aprovechar: 001 (practice/eval, TTS, STT, whisper), 007 (voz natural, pausas), 002 (whisper), 106 (timestamps/coloreado), 102 (sesión), 103 (disparador), 107 (continuo, ola 5 — este spec cubre 1 pregunta, el loop de apertura).
- Endpoint actual: `/api/practice/new`, `/api/evaluate`, `/api/transcribe`, `/api/session/save`.

## Qué hace

Implementa el flujo de práctica por fases de CU2 para **una pregunta** (el flujo continuo Q1→Q∞ se suma en 107):

```
INTRO     coach habla (TTS): contexto del tópico + dinámica (CU2 paso 1)
QUESTION  pregunta mostrada en pantalla y leída (p.1-2); transcript en vivo del coach
MODEL     LLM genera respuesta fuerte del coach; se muestra como letra Spotify
          (karaoke 40px Space Grotesk, anotación de pronunciación legible opcional: respelling WUR·king derivado de IPA, fallback aproximado ~ para palabras fuera del dict) — coach la lee completa (p.3-5)
EXPLAIN   coach explica: "voy a leer por fragmentos, repítelos" (p.6); se resalta el fragmento (p.7)
LOOP      por cada fragmento:
             coach dice fragmento (p.8)
             usuario repite (grabar → 106 timestamps + score) (p.9)
             colores por palabra verde/ámbar/rojo + animación sincronizada (p.10)
             coach da feedback por voz (p.11)
             pasa al siguiente (p.12) ó reintento si no pasa umbral (CU2 alt)
FULL      coach instruye "lee la respuesta entera" (p.14); colores quitados, se resalta todo (p.15)
          usuario lee entera → colores marcados en vivo al hablar (p.16-17)
          coach evalúa y da feedback consolidado (p.18)
DONE      se cierra la conversación, se oculta, botón "hacer otra práctica" (p.19-20) → vuelve a config
```

## Por qué

CU2 define la experiencia: práctica audiolingüística guiada con karaoke y feedback por palabra. 105 orquesta fases, eventos de voz y persistencia del progreso por fragmento hacia `questions[]` (102) — reemplazando el flujo "Repeat after me" simple de 001 en la UI nueva (el motor de eval se reutiliza).

## Requerimientos funcionales

- [x] **Máquina de estados de práctica** (client): `intro → question → model → explaining → repeatingFragment → feedback → fullAnswer → done`, con transiciones reactivas a eventos TTS/STT (timeout de guarda en cada fase).
- [x] **INTRO:** texto de apertura generado por LLM (topic + dinámica), hablado con pausas medias (007); transcript IA se muestra como subtítulo (diseño: "columna del coach").
- [x] **QUESTION:** `POST /api/session/start` (103) genera `{ question }` y la respuesta modelo `{ answer, fragments[] }` (fragmentos = cortes por cláusula/pausa natural, no >18 palabras); `GET /api/session/:id` los sirve a la vista.
- [x] **Karaoke:** línea activa grande (`40px`), líneas adyacentes atenuadas, blur, scroll con mask-gradient; al reproducir audio del coach el texto se subraya palabra a palabra (fallback: progreso lineal por duración).
- [x] **LOOP fragmentos:** en fases de repetición el micrófono **escucha automáticamente** (beep de preparación → VAD por silencio, orb como indicador no clickeable) y graba WAV (recorder-wave) → llama `/api/attempt` (transcribe + evalúa + alinea + persiste). Resultado: `words[]` con estados green/amber/red sobre la línea activa; al fallar, la grabación del usuario se repite con esos colores ya visibles (sin animación azul superpuesta).
- [x] **Feedback del coach:** `buildFeedbackText` genera el feedback hablado (score + foco en missing y/o en palabras de más); se habla; la chip de feedback del diseño ("Buen flujo · N%") se muestra en el header.
- [x] **Score estricto con palabras añadidas:** `score = penalizedScore(targetWords, matched, extrasNoFiller)` — implementado en `alignWords`/`alignTextWords` y `wordMatch` (`practice.ts`): cada palabra dicha fuera del fragmento resta del numerador (los fillers naturales uh/um/hmm… no penalizan y siguen reportándose en `extra`). Así, repetir el fragmento *incrustado* en contenido inventado ya no da 100% ni supera `passThreshold`; `/api/attempt` devuelve `addedWords` (extras sin fillers) y el coach los nombra (chip "palabras de más" + `Drop the extra words: …` hablado). Los tokens de solo puntuación que emite whisper (p. ej. un `.` suelto) **no son palabras**: no participan en el alineamiento, no se pintan como extras y no cuentan como inserción (regresión: fragmento perfecto + `.` = 92 < rigor Estricto 93 ⇒ bucle de reintento infinito).
- [x] **Reintento:** si `score < passThreshold` (settings 108; default 70), coach reclama el fragmento y loop interno de reintento (CU2 alt).
- [x] **FULL / cierre:** fase de respuesta entera con el mismo pipeline; consolidación del feedback final y guardado del `eval` de la pregunta en la sesión (102).
- [x] **Persistence:** cada paso relevante hace `saveSession` (idempotente) — al terminar fragmento, al cierre; el "Cancelar/Salir" deja status `active` (resumible, 109).
- [x] **"Hacer otra práctica"** → `#/` (config).
- [x] Indicador de driver de voz en curso: pill "Speech Engine · READY" refleja whisper/edge/piper vividos.

## Requerimientos no funcionales

- UX: detección de fallo de micrófono con mensaje claro si `getUserMedia` denegado; no se pierde el fragmento en curso.
- Responsive: book del karaoke crece en tablet/móvil (letra activa 26px).
- Toda llamada LLM lleva "Learner memory" (convención tech-stack).

## Decisiones de diseño / tecnología

- Las fases se modelan en `src/lib/fragments.ts`/`src/lib/practice.ts` como funciones puras (STT/TTS son efectos de capa fina vía `src/lib/audio.ts` helper no presente — acotar: crear `src/lib/cu2.ts` como orquestador puro de fases con eventos).
- TTS segmentado: se pre-sintetiza intro, pregunta, fragmento, feedback (007 ya produce audio por segmento); se reproducen colas con pausa natural.
- El "voice coach transcript" es `session.questions[n].answer` (no escribe); los "substack" del usuario → `fragments[i].attempts[]`.
- Prioridad de motores: audio con timestamps de Piper si disponen; sin ellos, progreso lineal.

## Dependencias

- 102 (sesión), 106 (colores y timestamps), 103 (arranque); el **dock de audio (orb/waveform/tempo)** es parte de 105 sobre el shell de 101; backend de 001/007 ya implementado; 108 (umbral pass); 109 (salida/reanudación).

## Criterios de aceptación

- [x] El flujo completo CU2 se puede recorrer con whisper instalado; con whisper ausente, colores degradan a green/red por matching textual (106 fallback).
- [x] El coloreado refleja las palabras mal dichas; el reintento funciona; el porcentaje score por fragmento se persiste en `session.questions[0].fragments[i]`.
- [x] Repetir el fragmento incrustado en palabras inventadas (ej. 11 palabras de target + 5 de más) puntúa 55 y reintenta; decirlo solo con fillers (uh/um) puntúa 100 (tests de regresión en `tests/align.test.ts` / `tests/wordmatch.test.ts`).
- [x] Al "Finalizar Sesión" la sesión queda `completed` con `eval` y aparece en el historial (109).
- [x] Tests: evaluación por fragmento (wordmatch test amplía a `words[]`), máquina de estados (tests/cu2.test.ts), y `npm test` / `npm run check` verdes.

## Fuera de alcance

- Flujo continuo Q1→Q∞ y adaptativa (107). Precisión de colores fonéticos (004). IPA inspector panel (futuro). Free chat (eliminado por 101).

## Recursos

- `spec/use-cases/CU2.md`, `spec/design/screens.md` §2, `spec/design/design-system.md` (componentes karaoke/waveform/orb/chips), `src/lib/practice.ts`, `src/server.ts`, `public/speech/*`.