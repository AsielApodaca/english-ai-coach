# English AI Coach

App web local para practicar inglés técnico como conversación hablada con IA: entrevistas, método STAR, daily standups y temas libres. La IA habla, escucha, responde con contexto y corrige sobre la marcha como un interlocutor humano; la transcripción acompaña como subtítulo. La pronunciación se evalúa por fonética/audio (sidecar Python opcional: parselmouth/librosa) con fallback a transcripción. Presupuesto: $0 (LLMs gratuitos).

## Stack
- Lenguaje: TypeScript estricto (Node 26, type stripping nativo ESM, sin build)
- Framework / runtime: Node 26 + Express 5
- Base de datos: JSON local en `data/` (perfil + sesiones), sin BD ni ORM
- Tests: `node:test` + `node:assert` (cero dependencias)

## Comandos
- `npm start` — arranca el servidor local en http://localhost:3000 (con watch)
- `npm run setup` — instala y configura whisper.cpp local (opcional; requiere Homebrew)
- `npm run check` — gate de tipos (`tsc --noEmit`) + verificación de sintaxis (`node --check`) de **todo** `src/` y `public/` vía `find` (type stripping, sin lista explícita de paths)
- `npm test` — suite de tests (deben pasar antes de cada commit)
- No hay lint ni formatter configurados: el gate de calidad es `npm run check` + `npm test`.

## Estructura del proyecto
- `src/server.ts` — punto de entrada: env → singletons → `createApp` → `listen` (único módulo que abre puerto).
- `src/lib/app.ts` — `createApp(deps)`: middleware JSON/static, registro de rutas y errores globales `/api/*` (sin efectos al importar; lo usan los tests HTTP).
- `src/lib/` está organizado por carpetas de dominio (`audio/ ingest/ lookup/ practice/ providers/ routes/ session/ settings/ util/`); en la raíz solo viven `app.ts` y `http-errors.ts`. Una feature nueva mete su módulo en la carpeta de su dominio.
- `src/lib/routes/` — registradores por dominio (`registerXxxRoutes`): health, practice, attempt, session, sessions, profile, audio, chat, lookup, files.
- `src/lib/providers/` — capa LLM (gemini, cloudflare, ollama, mock) + registry con fallback.
- `src/lib/practice/practice.ts` — generación de sets de práctica y evaluación híbrida (determinista + LLM).
- `src/lib/practice/refinement.ts` — refino LLM en background para el pintado incremental (feature 116).
- `src/lib/practice/learner.ts` — memoria: perfil, progreso, próximo paso.
- `src/lib/session/storage.ts` — persistencia JSON de `data/profile.json` y `data/sessions/*.json`.
- `src/lib/audio/whisper.ts` — subprocess `whisper-cli` (STT local opcional).
- `src/lib/practice/align.ts` — alineación de palabras vs. fragmento (green/amber/red).
- `src/lib/practice/karaoke.ts` — máquina de estados de la práctica karaoke (CU2).
- `src/lib/practice/continuous.ts` — preguntas continuas y dificultad adaptativa (107).
- `src/lib/session/session-start.ts`, `session-payload.ts` — arranque y contrato de `GET /api/session/:id`.
- `src/lib/settings/settings.ts` — settings del perfil (precedencia snapshot > local > perfil > defaults).
- `src/lib/audio/prosody.ts`, `tts-cache.ts`, `edge-tts.ts`, `piper.ts` — cadena TTS (pausas, caché LRU, motores).
- `src/lib/lookup/lookup.ts` — diccionario híbrido del popover léxico (112).
- `src/lib/ingest/extract.ts` — ingesta de archivos de contexto PDF/DOCX/TXT/MD (104).
- `src/lib/util/` — infraestructura compartida entre dominios: `subprocess.ts` (presupuestos de spawn + `snip()`) y `time.ts` (`MS_PER_S`, `MS_PER_MIN`).
- `public/` — frontend vanilla: `index.html`, `styles.css`, `app.js`, `ui/` (componentes), `speech/` (voz).
- `models/` — modelos locales (whisper.cpp `ggml-small.en.bin`, voces Piper).
- `data/` — `profile.json`, `sessions/*.json`, `tmp/` (audio y caché; ignorada por git).
- `spec/` — `constitution/` (misión, stack, roadmap), `features/` por carpeta, `use-cases/` (CU1–CU3), `design/`.
- `tests/` — tests de `node:test` (`*.test.ts`, 44 archivos).
- `scripts/setup.sh` — instalador de whisper.cpp, Piper y edge-tts.

## Convenciones
El código se escribe para que un agente IA lo lea completo sin contexto prevo: nada depende de "estar en la rama correcta" ni de un historial de conversación para entenderlo.
- camelCase para variables y funciones; UpperCamelCase para tipos.
- Módulos pequeños (<~300 líneas) con una responsabilidad por archivo; si un archivo crece, se parte por dominio, no por tipo de código.
- Funciones puras en `lib/`; efectos (I/O, red) acotados a una capa fina.
- Contratos explícitos al inicio del archivo: firmas con tipos, `interface`s de datos y el shape JSON de entrada/salida de `/api/*`. Nada de inferencia opaca ni `any` sin justificarlo.
- Comportamiento determinista: mismas entradas → mismas salidas; sin estado oculto entre módulos ni side effects en import time.
- Nombres que expliquen el "porqué" (`evaluateFragmentDeterministic`, no `handleThing2`); constantes con nombre para magic numbers (umbrales, timeouts, límites).
- Tests en `tests/*.test.ts` junto a la lógica que cubren: son la especificación ejecutable que un agente lee antes de tocar código; una feature nueva llega con su test.
- El código escrito debe llevar documentación (comentarios/JSDoc en funciones no triviales): qué hace, parámetros y casos límite, en inglés. El "porqué" de una decisión va en el JSDoc o en `spec/`, no solo en el commit.
- Toda salida de LLM se asume texto ≥ JSON; extraer JSON robusto (tolera code fences y ruido) antes de usar.
- Errores de red LLM: envolver en `ProviderError` y dejar que la cadena de fallback pruebe el siguiente proveedor.
- La llave de Cloudflare se auto-descubre desde `~/.local/share/opencode/auth.json` (fallback: `CLOUDFLARE_API_TOKEN` env) y la de Gemini desde `GEMINI_API_KEY`. Nunca hardcodear llaves.
- Peticiones a `/api/*` con body JSON; errores como `{ error: string }` con status HTTP coherente.
- Si un cambio toca un contrato (`/api/*`, shape de sesión, settings), actualiza `spec/` en el mismo cambio.
- UI: la región central de la pantalla (toda la vista sin sidebar ni top bar) se llama **`main-area`**; es el contenedor de las vistas de CU (config y práctica). Sinónimo obsoleto: "central stage". Ver `spec/design/screens.md`.
## No hagas
- No subir `.env*` ni `data/` al repositorio (secreto + datos personales de práctica). Están en `.gitignore`.
- No instalar dependencias npm sin avisar. Objetivo: mínimo absoluto (Express únicamente).
- No almacenar audio del usuario en el repositorio; usar `data/tmp/` (ignorada).
- No usar `any` en TypeScript sin justificarlo.
- No escribir metaprogramming, generación dinámica de código, monkey-patching ni abstracciones "clever"; prefiere código literal aunque sea más largo — es legible para una IA y para una persona.
- No dejar efectos ocultos (estado global, side effects en import time, mutación compartida): un agente que lea un módulo debe poder razonar sobre él aislado.
- No cambiar un contrato sin su documentación: si se modifica `/api/*`, el shape de sesión o settings y `spec/` no se actualiza, el cambio está incompleto.
- No llamar al LLM sin incluir el bloque "Learner memory" disponible en el momento (memoria del aprendiz).
- Después de un cambio importante en el sistema, evaluar si es necesario actualizar el `README.md` y actualizarlo si aplica.

## Flujo de trabajo
- Antes de una tarea no trivial, propón un plan y espera OK.
- Una tarea a la vez; al terminar, dime que cambiaste para revisarlo.
- Si no estás seguro al 80%, pregunta. No inventes.
- Antes de abrir un PR: si la PR cierra/completa una feature, actualizar `spec/features/<n>/spec.md` (estado y criterios) y mover la feature en `spec/constitution/roadmap.md` a "Hecho ✅" dentro de la misma rama/PR.

## Documentación
- Especificaciones en `spec/` (constitution + features). Ver `spec/constitution/roadmap.md` para el estado.
- Al documentar una feature nueva en `spec/features/`, seguir la plantilla base `spec/features/001-ejemplo/` (`spec.md`, `plan.md`, `tasks.md`): misma estructura de secciones, nivel de detalle y estilo de criterios verificables.
- Casos de uso en `spec/use-cases/` (CU1 configuración, CU2 práctica, CU3 historial) y diseño en `spec/design/` (design-system, screens, ui-flow).