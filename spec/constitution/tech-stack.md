# Tech stack y convenciones

## Tecnologías

- **Lenguaje:** TypeScript (ESM, type stripping nativo de Node 26 — sin build)
- **Runtime / server:** Node 26 + Express 5
- **LLM (multi-proveedor, $0):**
  - OpenCode Zen — modelo `big-pickle`, endpoint `https://opencode.ai/zen/v1/chat/completions` (API OpenAI-compatible), llave en `~/.local/share/opencode/auth.json`
  - Google Gemini — `gemini-2.5-flash` (free tier), endpoint `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`, llave en `GEMINI_API_KEY`
  - Cloudflare Workers AI — modelo free-tier, token en `CLOUDFLARE_API_TOKEN` + account id en `CLOUDFLARE_ACCOUNT_ID`
  - Ollama local — `http://localhost:11434/v1/chat/completions` (opcional offline, modelo configurable)
- **STT:** Chrome Web Speech API (`webkitSpeechRecognition`) por defecto; `whisper-cli` (brew `whisper-cpp`) opcional para transcripción local de WAV subido por el navegador
- **TTS:** `speechSynthesis` del navegador (voces en inglés)
- **Almacenamiento:** JSON local en `data/` (perfil + sesiones), sin base de datos
- **Tests:** `node:test` + `node:assert` (cero dependencias)
- **Despliegue:** local — `npm start` en http://localhost:3000

## Archivos / módulos clave

- `src/server.ts` — Express: sirve `public/`, expone `/api/*`.
- `src/lib/providers/index.ts` — registro de proveedores, selección y cadena de fallback.
- `src/lib/providers/zen.ts` — cliente OpenAI-compatible (big-pickle) leyendo la llave de auth.json.
- `src/lib/providers/gemini.ts` — cliente Generative Language API.
- `src/lib/providers/cloudflare.ts` — cliente Workers AI.
- `src/lib/providers/ollama.ts` — cliente Ollama local.
- `src/lib/practice.ts` — generación de sets de práctica (JSON) y evaluación híbrida (determinista + LLM).
- `src/lib/learner.ts` — resumen del aprendiz, métricas de progreso, motor de "next step".
- `src/lib/storage.ts` — carga/guardado de `data/profile.json` y `data/sessions/*.json`.
- `src/lib/whisper.ts` — subprocess `whisper-cli` para transcripción local.
- `public/` — frontend vanilla: `index.html`, `styles.css`, `app.js`, `speech/browser-stt.js`, `speech/browser-tts.js`, `speech/recorder-wave.js`.

## Comandos

- `npm install` — instala dependencias
- `npm run setup` — instala y configura whisper.cpp local (opcional; requiere Homebrew)
- `npm start` — arranca el servidor local
- `npm run check` — comprobación de sintaxis (type stripping) + health check
- `npm test` — suite con `node:test`

## Modelo de datos / dominio

- `data/profile.json` — estado del aprendiz: `{ level, categories, weakErrors[], vocabGaps[], recentTopics[], nextStep }`
- `data/sessions/<id>.json` — sesión: `{ id, date, category, level, provider, question, fragments[], scores, feedback[], fullAnswer }`
  - `fragments[]`: `{ id, stage, text, attempts[], passed }`
  - `attempts[]`: `{ text, score, missing[], issues[], verdict }`
- `practiceSet` (respuesta de generación): `{ question, context, fragments: [{id, stage, text}] }`
- `feedback` (evaluación): `{ score, verdict, matched, missing[], extra[], issues: [{type|word-warning, category, message}], tips[], next }`

## Convenciones

- camelCase variables/funciones; UpperCamelCase tipos; archivos en kebab-case.
- `lib/` con funciones puras; el server orquesta efectos.
- Salida de LLM: siempre extraer JSON robusto (fences, ruido, trailing commas tolerados).
- Errores LLM: `ProviderError` con `canRetry` para guiar la cadena de fallback.
- Claves: nunca en el código; env vars o auth.json existente.
- API REST JSON; respuestas de error con `{ error }` y status HTTP.

## Límites duros

- No añadir dependencias npm sin avisar. Objetivo: mínimo absoluto (Express únicamente).
- No tocar `data/` ni `.env*` fuera del runtime; están en `.gitignore`.
- No persistir audio del usuario.
- No subir nada del historial personal del aprendiz a GitHub.