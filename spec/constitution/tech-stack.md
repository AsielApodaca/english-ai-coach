# Tech stack y convenciones

## Tecnologías

- **Lenguaje:** TypeScript estricto (ESM, type stripping nativo de Node 26 — sin build)
- **Framework / runtime:** Node 26 + Express 5
- **Base de datos:** JSON local en `data/` (perfil + sesiones); sin BD ni ORM
- **Tests:** `node:test` + `node:assert`
- **Despliegue:** local — `npm start` en http://localhost:3000

### Servicios externos

- **LLM (multi-proveedor, $0):**
  - OpenCode Zen — modelo `big-pickle`, API OpenAI-compatible, llave en `~/.local/share/opencode/auth.json` (fallback: `ZEN_API_KEY`)
  - Google Gemini — `gemini-2.5-flash` free tier, llave en `GEMINI_API_KEY`
  - Cloudflare Workers AI — free tier, `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
  - Ollama local — `http://localhost:11434/v1/chat/completions` (opcional offline)
- **STT:** Chrome Web Speech API (`webkitSpeechRecognition`) por defecto; `whisper-cli` local opcional (WAV subido)
- **Fonética (pronunciación por audio):** sidecar local Python (parselmouth/librosa) que recibe el WAV y devuelve análisis fonético (fonemas, estrés, ritmo, entonación); opcional, con fallback a solo transcripción
- **TTS:** voz neural local **Piper** (subprocess, offline, prosodia y pausas controladas); «edge-tts» como alternativa online si Piper no está instalado. `speechSynthesis` del navegador queda como último fallback.

## Decisión de herramientas / arquitectura modular

**Enfoque: módulos separados, cada uno con la tecnología más adecuada.** El core quedó en Node/TS (integración HTTP + LLM + subprocess, ligero con type-stripping); la fonética es un service sidecar en Python con API mínima (WAV → fonemas/score). Se descartaron migrar el core a Python o Go:

- **Node/TS (core)** — el dominio es integración (REST, LLM, subprocess, JSON local), no cómputo pesado. Reescribir a Go/Python sería costo sin beneficio. Se mantiene.
- **Go (sidecar audio/transcripción a futuro)** — binario único + concurrencia y buen throughput para streaming; no hay ecosistema de fonética y hoy no se necesita. Queda como reemplazo futuro del sidecar Python, no del core.
- **Python (sidecar fonética)** — estándar de facto para análisis de audio/fonética (parselmouth, librosa, faster-whisper). Expone `/pronounce` local; si falta o falla, el flujo degrada a evaluación por transcripción.
- **Escalabilidad/resiliencia** — cada módulo escala/falla por separado; el core funciona sin el sidecar (fallback a transcripción). Sin riesgo de single-language lock-in.

## Archivos / módulos clave

- `src/server.ts` — Express: sirve `public/`, expone `/api/*`.
- `src/lib/providers/index.ts` — registro de proveedores, selección y cadena de fallback.
- `src/lib/providers/zen.ts` — cliente OpenAI-compatible (big-pickle), llave desde auth.json.
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
- `practiceSet` (generación): `{ question, context, fragments: [{ id, stage, text }] }`
- `feedback` (evaluación): `{ score, verdict, matched, missing[], extra[], issues: [{ type|word-warning, category, message }], tips[], next }`

## Convenciones

- camelCase variables/funciones; UpperCamelCase tipos; archivos en kebab-case.
- `lib/` con funciones puras; el server orquesta efectos.
- Salida de LLM: siempre extraer JSON robusto (fences, ruido, trailing commas tolerados).
- Errores LLM: `ProviderError` con `canRetry` para guiar la cadena de fallback.
- Claves: nunca en el código; env vars o auth.json existente.
- API REST JSON; respuestas de error con `{ error }` y status HTTP.

## Estilo visual

- Tema oscuro con tokens CSS: `--bg`, `--panel`, `--border`, `--text`, `--muted`, `--accent`, `--green`, `--amber`, `--red`.
- Sistema de color: acento azul (`#4f8cff`), éxito verde (`#34d399`), advertencia ámbar (`#fbbf24`), error rojo (`#f87171`).
- Tipografía: sistema (`-apple-system, BlinkMacSystemFont, Segoe UI, Roboto, Helvetica, Arial`).
- Layout: barra superior fija con tabs; paneles por sección; cards en 2 columnas (responsive a 1 columna en móvil).

## Límites duros

- No añadir dependencias npm sin avisar. Objetivo: mínimo absoluto (Express únicamente).
- No tocar `data/` ni `.env*` fuera del runtime; están en `.gitignore`.
- El audio se procesa/persiste solo en memoria o en `data/tmp/` (ignorada); no persiste el audio del usuario.
- No subir nada del historial personal del aprendiz a GitHub.