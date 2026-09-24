# Tech stack y convenciones

## Tecnologías

- **Lenguaje:** TypeScript estricto (ESM, type stripping nativo de Node 26 — sin build)
- **Framework / runtime:** Node 26 + Express 5
- **Base de datos:** JSON local en `data/` (perfil + sesiones); sin BD ni ORM
- **Tests:** `node:test` + `node:assert`
- **Despliegue:** local — `npm start` en http://localhost:3000

### Servicios externos

- **LLM (multi-proveedor, $0):**
  - Google Gemini — `gemini-2.5-flash` free tier, llave en `GEMINI_API_KEY`
  - Cloudflare Workers AI — free tier, `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
  - Ollama local — `http://localhost:11434/v1/chat/completions` (opcional offline)
- **STT:** `whisper-cli` local (WAV subido) como motor primario de práctica; **Chrome Web Speech API** (`webkitSpeechRecognition`) como fallback en navegadores sin whisper instalado. Para el coloreado palabra a palabra se usa la **salida word-timestamps** de whisper (`-ml 1` / JSON).
- **Fonética (pronunciación por audio):** sidecar local Python (parselmouth/librosa) que recibe el WAV y devuelve análisis fonético (fonemas, estrés, ritmo, entonación); opcional (backlog, `004`), con fallback a solo transcripción. Hasta que exista, el ámbar/rojo se determina por alineación de palabras + evaluación LLM.
- **TTS:** voz neural local **Piper** (subprocess, offline, prosodia y pausas controladas); «edge-tts» como alternativa online si Piper no está instalado. `speechSynthesis` del navegador queda como último fallback.
- **Frontend:** SPA vanilla en `public/` (sin build, continuo con el stack); layout "cockpit" (sidebar full-height + top bar a la derecha + central stage; ver `../design/design-system.md`). Estilos en `styles.css` con tokens CSS del design system; componentes en `public/ui/`. Funciones de voz en `public/speech/`. Material Symbols + Google Fonts como hoy.
- **Ingesta de archivos de contexto (CU1 dropzone):** extracción de PDF y DOCX con las únicas dependencias npm permitidas además de Express: `pdf-parse` y `mammoth`. TXT/MD se leen directamente. **Excepción documentada y única a la regla de "sin dependencias"** (ver feature `104-context-files`).

## Decisión de herramientas / arquitectura modular

**Enfoque: módulos separados, cada uno con la tecnología más adecuada.** El core quedó en Node/TS (integración HTTP + LLM + subprocess, ligero con type-stripping); la fonética es un service sidecar en Python con API mínima (WAV → fonemas/score). Se descartaron migrar el core a Python o Go:

- **Node/TS (core)** — el dominio es integración (REST, LLM, subprocess, JSON local), no cómputo pesado. Reescribir a Go/Python sería costo sin beneficio. Se mantiene.
- **Go (sidecar audio/transcripción a futuro)** — binario único + concurrencia y buen throughput para streaming; no hay ecosistema de fonética y hoy no se necesita. Queda como reemplazo futuro del sidecar Python, no del core.
- **Python (sidecar fonética)** — estándar de facto para análisis de audio/fonética (parselmouth, librosa, faster-whisper). Expone `/pronounce` local; si falta o falla, el flujo degrada a evaluación por transcripción.
- **Escalabilidad/resiliencia** — cada módulo escala/falla por separado; el core funciona sin el sidecar (fallback a transcripción). Sin riesgo de single-language lock-in.

## Archivos / módulos clave

- `src/server.ts` — Express: sirve `public/`, expone `/api/*`.
- `src/lib/providers/index.ts` — registro de proveedores, selección y cadena de fallback.
- `src/lib/providers/gemini.ts` — cliente Generative Language API.
- `src/lib/providers/cloudflare.ts` — cliente Workers AI.
- `src/lib/providers/ollama.ts` — cliente Ollama local.
- `src/lib/practice.ts` — generación de sets de práctica (JSON) y evaluación híbrida (determinista + LLM).
- `src/lib/learner.ts` — resumen del aprendiz, métricas de progreso, motor de "next step".
- `src/lib/storage.ts` — carga/guardado de `data/profile.json` y `data/sessions/*.json`.
- `src/lib/whisper.ts` — subprocess `whisper-cli` para transcripción local (modos texto plano y word-timestamps JSON).
- `public/` — frontend vanilla SPA: `index.html` (shell cockpit: sidebar + top bar + stage), `styles.css` (design system), `app.js` (router SPA), `ui/` (componentes), `speech/` (browser-stt, browser-tts, recorder-wave, stt-pick).
- `scripts/setup.sh` — instalador de whisper.cpp, Piper y edge-tts.

## Comandos

- `npm install` — instala dependencias
- `npm run setup` — instala y configura whisper.cpp local (opcional; requiere Homebrew)
- `npm start` — arranca el servidor local
- `npm run check` — comprobación de sintaxis (type stripping) + health check
- `npm test` — suite con `node:test`

## Modelo de datos / dominio

- `data/profile.json` — estado del aprendiz: `{ level, categories, weakErrors[], vocabGaps[], recentTopics[], focusPhonemes[], lastSessionAt, nextStep }`
- `data/sessions/<id>.json` — sesión **v2** (modelo ampliado en `../features/102-session-model-v2/spec.md`):
  - \`\`\`{ id, status: "active"|"completed", createdAt, updatedAt, config: { topicPrompt, level, category, accent, phonemes[], contextFiles[], settingsSnapshot }, provider, questions: [ { q, answer, fragments:[{ id, text, attempts:[{text, words:[{word,status}], score}], passed }], fullAttempt, eval } ] }\`\`\`
  - Niveles: **A1–C2 (CEFR completo)**; el enum actual B1/B2/C1 se amplía.
  - `status` permite sesiones continuas reanudables (CU3 / `109`).
- `practiceSet` (generación): `{ question, context, fragments: [{ id, stage, text }] }` (el stage se generaliza: en karaoke corresponde al índice de fragmento).
- `feedback` (evaluación): `{ score, verdict, matched, missing[], extra[], issues: [{ category, message, fix }], tips[], next }`

## Convenciones

- camelCase variables/funciones; UpperCamelCase tipos; archivos en kebab-case.
- `lib/` con funciones puras; el server orquesta efectos.
- Salida de LLM: siempre extraer JSON robusto (fences, ruido, trailing commas tolerados).
- Errores LLM: `ProviderError` con `canRetry` para guiar la cadena de fallback.
- Claves: nunca en el código; env vars o auth.json existente.
- API REST JSON; respuestas de error con `{ error }` y status HTTP.
- Toda llamada LLM incluye el bloque "Learner memory" de `learner.ts`; el rol del coach (instrucción del usuario) se inyecta como system persona.
- Sesiones v2: toda escritura a `data/sessions/<id>.json` es idempotente (save del estado completo actual, no merge de parches).

## Estilo visual

- **Tema oscuro "Resonance Dark AI"** (referencia normativa: `../design/design-system.md`).
- Tokens CSS: `--bg`, `--panel`, `--panel-2`, `--panel-3`, `--border`, `--text`, `--muted`, `--subtle`, `--accent (#10b981)`, `--accent-cyan`, `--amber`, `--red`, `--surface-variant`, `--outline`.
- Tipografía tri: Space Grotesk (display/karaoke) · Inter (diálogo/config) · JetBrains Mono (IPA/técnico). Material Symbols para iconos.
- Layout: **cockpit** — sidebar full-height (brand, New Session, historial 280px, footer usuario/motores) + top bar a la derecha (breadcrumb, toggle) + central stage + panel derecho opcional. El dock de audio (push-to-talk, waveform, tempo, VU meter) llega con 105/CU2.

## Límites duros

- No añadir dependencias npm sin avisar. Objetivo: mínimo absoluto (Express + **excepción única:** `pdf-parse` y `mammoth` para ingesta de archivos, feature `104`).
- No tocar `data/` ni `.env*` fuera del runtime; están en `.gitignore`.
- El audio se procesa/persiste solo en memoria o en `data/tmp/` (ignorada); no persiste el audio del usuario.
- **Free chat queda fuera del MVP del rediseño** (la UI nueva no lo incluye); el endpoint `/api/chat` se retira o se mantiene inerte según indicación en desarrollo.
- No subir nada del historial personal del aprendiz a GitHub.