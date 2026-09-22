# 105 · Práctica karaoke estilo Spotify (CU2)

**Estado:** planificado 🔜 (ola 4)

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
          (karaoke 40px Space Grotesk, anotación IPA opcional) — coach la lee completa (p.3-5)
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

- [ ] **Máquina de estados de práctica** (client): `intro → question → model → explaining → repeatingFragment → feedback → fullAnswer → done`, con transiciones reactivas a eventos TTS/STT (timeout de guarda en cada fase).
- [ ] **INTRO:** texto de apertura generado por LLM (topic + dinámica), hablado con pausas medias (007); transcript IA se muestra como subtítulo (diseño: "columna del coach").
- [ ] **QUESTION:** `POST /api/practice/next` (o `session/next-question`) genera `{ question }` y la respuesta modelo `{ answer, fragments[] }` (fragmentos = cortes por cláusula/pausa natural, no >18 palabras).
- [ ] **Karaoke:** línea activa grande (`40px`), líneas adyacentes atenuadas, blur, scroll con mask-gradient; al reproducir audio del coach el texto se subraya palabra a palabra (timestamps del TTS de Piper si se generan; fallback: progreso lineal por duración).
- [ ] **LOOP fragmentos:** UI habilita el orb (push-to-talk del dock) solo en fases de repetición; al soltar graba WAV (recorder-wave), llama `/api/evaluate` (score, missing, extras, issues) + `/api/transcribe` con word-timestamps (106). Resultado: `words[]` con estados green/amber/red sobre la línea activa + animación sincronizada con audio propio del usuario (nuevo intento reproduce su WAV con la letra iluminada).
- [ ] **Feedback del coach:** LLM genera feedback con corrección enfocada (include ipa suggestions si 004 fuera activable); se habla; la chip de feedback del diseño ("Buen flujo · Foco en /tʃ/ · 92%") se muestra en el header.
- [ ] **Reintento:** si `score < passThreshold` (settings 108; default 70), coach reclama el fragmento y loop interno de reintento (CU2 alt).
- [ ] **FULL / cierre:** fase de respuesta entera con el mismo pipeline; consolidación del feedback final y guardado del `eval` de la pregunta en la sesión (102).
- [ ] **Persistence:** cada paso relevante hace `saveSession` (idempotente) — al terminar fragmento, al cierre; el "Cancelar/Salir" deja status `active` (resumible, 109).
- [ ] **"Hacer otra práctica"** → `#/` (config).
- [ ] Indicador de driver de voz en curso: pill "Speech Engine · READY" refleja whisper/edge/piper vividos.

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

- 101 (shell/dock), 102 (sesión), 106 (colores y timestamps), 103 (arranque); backend de 001/007 ya implementado; 108 (umbral pass); 109 (salida/reanudación).

## Criterios de aceptación

- [ ] El flujo completo CU2 se puede recorrer con whisper instalado; con whisper ausente, colores degradan a green/red por matching textual (106 fallback).
- [ ] El coloreado refleja las palabras mal dichas; el reintento funciona; el porcentaje score por fragmento se persiste en `session.questions[0].fragments[i]`.
- [ ] Al "Finalizar Sesión" la sesión queda `completed` con `eval` y aparece en el historial (109).
- [ ] Tests: evaluación por fragmento (wordmatch test amplía a `words[]`), máquina de estados (tests/cu2.test.ts), y `npm test` / `npm run check` verdes.

## Fuera de alcance

- Flujo continuo Q1→Q∞ y adaptativa (107). Precisión de colores fonéticos (004). IPA inspector panel (futuro). Free chat (eliminado por 101).

## Recursos

- `spec/use-cases/CU2.md`, `spec/design/screens.md` §2, `spec/design/design-system.md` (componentes karaoke/waveform/orb/chips), `src/lib/practice.ts`, `src/server.ts`, `public/speech/*`.