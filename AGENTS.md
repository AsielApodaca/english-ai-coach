# English AI Coach

App web local para practicar inglés técnico con IA: entrevistas, método STAR, daily standups y temas libres. La IA hace preguntas, guía repetición fragmento a fragmento ("Repeat after me"), escucha tu respuesta, la evalúa y corrige, y recuerda tu progreso para sugerir el siguiente paso. Presupuesto: $0 (LLMs gratuitos).

## Stack
- Lenguaje: TypeScript (Node 26, type stripping nativo ESM, sin build)
- Runtime / server: Node 26 + Express 5
- LLM: capa multi-proveedor con fallback — OpenCode Zen (`big-pickle`, gratis), Google Gemini (free tier), Cloudflare Workers AI (free tier), Ollama local (opcional offline)
- STT: Chrome Web Speech API (default) y whisper.cpp local (`whisper-cli`, opcional)
- TTS: `speechSynthesis` del navegador (voces en inglés)
- Almacenamiento: JSON local en `data/` (sesiones + perfil del aprendiz)
- Frontend: HTML/CSS/JS vanilla (sin bundler)

## Comandos
- `npm install` — instala dependencias
- `npm run setup` — instala y configura whisper.cpp local (opcional; requiere Homebrew)
- `npm start` — arranca el servidor en http://localhost:3000
- `npm run check` — verificación: sintaxis TS + health check local
- `npm test` — suite de tests (deben pasar antes de cada commit)

## Estructura del proyecto
- `src/server.ts` — Express: API + estáticos
- `src/lib/` — lógica de negocio
  - `providers/` — capa LLM (zen, gemini, cloudflare, ollama) + registry con fallback
  - `practice.ts` — generación de sets de práctica y evaluación híbrida
  - `learner.ts` — memoria: perfil, progreso, próximo paso
  - `storage.ts` — persistencia JSON de sesiones y perfil
  - `whisper.ts` — subprocess `whisper-cli` (STT local opcional)
- `public/` — frontend vanilla (UI en inglés)

## Convenciones
- camelCase para variables y funciones; UpperCamelCase para tipos.
- Funciones puras en `lib/`; efectos (I/O, red) acotados a una capa fina.
- Toda salida de LLM se asume texto ≥ JSON; extraer JSON robusto (tolera code fences y ruido) antes de usar.
- Errores de red LLM: envolver y dejar que la cadena de fallback pruebe el siguiente proveedor.
- La llave de Zen se lee de `~/.local/share/opencode/auth.json` (fallback: `ZEN_API_KEY` env). Nunca hardcodear llaves.
- Peticiones a `/api/*` con body JSON; errores como `{ error: string }` con status HTTP coherente.

## No hagas
- No subir `.env*` ni `data/` al repositorio (secreto + datos personales de práctica). Están en `.gitignore`.
- No instalar dependencias sin avisar.
- No almacenar audio del usuario en el repositorio; usar `data/tmp/` (ignorada).
- No usar `any` en TypeScript sin justificarlo.
- No llamar al LLM sin incluir el bloque "Learner memory" disponible en el momento (memoria del aprendiz).
- Después de un cambio importante en el sistema, evaluar si es necesario actualizar el `README.md` y actualizarlo si aplica.

## Flujo de trabajo
- Antes de una tarea no trivial, propón un plan y espera OK.
- Una tarea a la vez; al terminar, di qué cambiaste para revisarlo.
- Si no estás seguro al 80%, pregunta. No inventes.
- Antes de abrir un PR: si la PR cierra/completa una feature, actualizar `spec/features/<n>/spec.md` (estado y criterios) y mover la feature en `spec/constitution/roadmap.md` a "Hecho ✅" dentro de la misma rama/PR.

## Documentación
- Especificaciones en `spec/` (constitution + features). Ver `spec/constitution/roadmap.md` para el estado.