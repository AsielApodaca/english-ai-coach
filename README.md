# English AI Coach

App web local para practicar inglés técnico como conversación hablada con IA: entrevistas, método STAR, daily standups y temas libres. La IA habla, escucha, responde con contexto y corrige sobre la marcha; la transcripción acompaña como subtítulo. Corre 100% en local con LLMs gratuitos.

## Funcionalidades

- **Práctica guiada** — elige categoría (Entrevistas, Método STAR, Daily standup, Tema libre) y nivel (B1–C1); la IA genera pregunta + respuesta modelo fragmentada.
- **Conversación hablada** — subtítulos en vivo etiquetados Coach/You, palabras faltantes resaltadas en la frase del coach, extras resaltadas en lo que dijiste, y feedback hablado (voz mejorable; roadmap → feature 007).
- **Evaluación híbrida** — score 0-100 por word-match determinista + correcciones del LLM (grammar, word-choice, fluency, pronunciation).
- **Memoria** — el perfil del aprendiz (nivel, debilidades, temas recientes, next step) se inyecta en cada generación/evaluación.
- **Multi-proveedor LLM con fallback** — OpenCode Zen, Gemini, Cloudflare Workers AI y Ollama local.
- **STT** — whisper.cpp local por defecto cuando está instalado (100% offline/privado); Chrome Web Speech como fallback automático.

## Requisitos

- macOS (o Linux), **Node ≥ 23.4** (type stripping nativo, sin build).
- Sin suscripciones: un API key de LLM gratis (Gemini o Cloudflare) o una llave de OpenCode Zen.

## Puesta en marcha

```bash
npm install
npm start
```

Abre http://localhost:3000.

- **Configura tu LLM** copiando `.env.example` a `.env` (ver `LLM_PROVIDER`, `GEMINI_API_KEY`, `CLOUDFLARE_API_TOKEN`). El default `cloudflare` auto-descubre el account id desde tu config de opencode.
- **Whisper local (opcional)**: `npm run setup` instala `whisper-cpp` (Homebrew) y descarga el modelo en `models/`. Una vez listo, Whisper se auto-selecciona como STT por defecto (100% offline); Web Speech queda como fallback automático y puedes cambiarlo en Settings.

## Configuración

| Variable | Default | Descripción |
| --- | --- | --- |
| `LLM_PROVIDER` | `cloudflare` | `cloudflare` · `gemini` · `zen` · `ollama` |
| `GEMINI_API_KEY` | – | Free-tier de Google AI Studio |
| `CLOUDFLARE_API_TOKEN` | – | Workers AI (account id auto-descubierto) |
| `OLLAMA_MODEL` | `llama3.1` | Modelo Ollama local |
| `PORT` | `3000` | Puerto del servidor |
| `WHISPER_MODEL` | `small.en` | Modelo whisper.cpp bajo `models/` |

## API

- `GET /api/health` — estado de proveedores LLM + Whisper.
- `POST /api/practice/new` — genera un set de práctica `{ category?, level?, provider?, personalized? }`.
- `POST /api/evaluate` — evalúa un intento `{ target, userText, question?, level?, sessionId?, fragmentId? }`.
- `POST /api/session/save` — guarda la sesión y calcula next step.
- `GET /api/history` · `GET /api/profile` · `GET /api/next-step` — historial, perfil y siguiente paso.
- `POST /api/transcribe` — transcripción local con whisper.cpp.

## Comandos

| Comando | Descripción |
| --- | --- |
| `npm start` | Servidor local con watch |
| `npm run start:no-watch` | Sin watch |
| `npm run setup` | Instala/configura whisper.cpp opcional |
| `npm run check` | Verificación de sintaxis TS |
| `npm test` | Suite `node:test` |

## Arquitectura

- **Backend**: Node + Express 5, TypeScript ESM sin build (`src/server.ts` + `src/lib/`).
- **Frontend**: vanilla (`public/`): `app.js`, `index.html`, `styles.css`, `speech/`.
- **Datos**: JSON local en `data/` (`profile.json` + `sessions/*.json`), para un usuario único.
- **Decisiones de futuro** (roadmap): core Node + sidecar Python para fonética (parselmouth/librosa), voz neural local Piper, conversación natural. Documentado en `spec/constitution/`.

## Especificaciones

Ver `spec/constitution/` (misión, tech stack, roadmap) y `spec/features/` (por feature). La arquitectura y la dirección de producto viven ahí.

## Privacidad

Los datos de práctica quedan en `data/` (fuera de git) y el audio no se persiste. No hay backend en la nube ni cuentas.

## Roadmap

Próximo (ver `spec/constitution/roadmap.md`): conversación hablada natural (003), evaluación fonética por audio (004), vocabulario con repaso espaciado, modo sin conexión total y voz humana neural (007).