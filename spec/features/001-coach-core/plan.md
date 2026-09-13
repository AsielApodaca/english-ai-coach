# 001 · Coach core — Plan

## Enfoque

Monolito pequeño en Node/Express con feature-free frontend. El LLM se usa para (a) generar sets de práctica como JSON estricto y (b) evaluar transcripciones con feedback estructurado. Un determinista (word-match normalizado) da la base del score para que la evaluación sea estable y barata; el LLM añade correcciones y taxonomía de errores que alimentan la memoria. La memoria (learner) resume sesiones pasadas en el prompt.

## Implementación

1. Scaffolding: `package.json`, `tsconfig.json`, `.env.example`, `.gitignore`, `scripts/setup.sh` (setup Whisper opcional).
2. `src/lib/storage.ts` — carga/guarda `data/profile.json` y `data/sessions/*.json` (JSON atómico: escribir a tmp + rename).
3. `src/lib/providers/*` — interfaz `chatJSON(req)`, implementaciones:
   - `zen.ts`: OpenAI-compatible, llave desde `~/.local/share/opencode/auth.json` o `ZEN_API_KEY`, modelo `big-pickle`.
   - `gemini.ts`: REST `generateContent`, modelo `gemini-2.5-flash`, llave `GEMINI_API_KEY`.
   - `cloudflare.ts`: REST Workers AI, `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, modelo free-tier.
   - `ollama.ts`: OpenAI-compatible local.
   - `index.ts`: `extractJSON` robusto + `runWithFallback(candidates)` con `ProviderError.canRetry`.
4. `src/lib/practice.ts` — prompts de generación (JSON `{question, context, fragments[]}` con etiquetas STAR) y evaluación (híbrida: `matchWords` determinista + prompt LLM con feedback estructurado).
5. `src/lib/learner.ts` — resumen del aprendiz desde sesiones (nivel estimado, promedio por categoría, errores frecuentes, temas recientes) + `buildNextStep()`.
6. `src/lib/whisper.ts` — subprocess `whisper-cli` (WAV 16k mono) con detección de disponibilidad y descarga de modelo `small.en` bajo `models/`.
7. `src/server.ts` — Express: estáticos, `/api/health`, `/api/practice/new`, `/api/evaluate`, `/api/transcribe`, `/api/history`, `/api/profile`, `/api/next-step`; subida de WAV con `multer` o `busboy` mínimo (o body-parser raw e in-memory).
8. `public/` — UI SPA vanilla (tabs: Practice, Progress, Settings): TTS browser, STT browser, recorder WAV (PCM16) para whisper; orquestación del flujo; selector de proveedor/motor/tiempos.
9. Tests (`node:test`): `extractJSON`, `matchWords`, `storage`, práctica sobre mock HTTP.

## Decisiones

- **JSON en vez de SQLite** — cero deps, inspeccionable y suficiente para un usuario (`data/`).
- **Relación determinista+LLM** — score híbrido: el word-match da estabilidad; el LLM dá correcciones ricas (1 llamada por intento).
- **WAV en el navegador** — PCM16 16 kHz exportado en el cliente (AudioWorklet/offline) para no depender de ffmpeg.
- **UI vanilla** — sin bundler ni framework; una sola página, JS modular.
- **TTS del navegador** — fue gratis y suficiente para el MVP; queda como último fallback. Ver feature 007 (voz neural Piper).

## Riesgos

- **Zen free limitado en el tiempo / 403** — mitigado por cadena de fallback a Gemini/Cloudflare/Ollama.
- **webkitSpeechRecognition solo Chrome** — se detecta y muestra aviso; Whisper local cubre otros navegadores/offline.
- **Whisper no instalado** — el flujo funciona con browser STT; el switch muestra estado e instrucciones.
- **Salida LLM no-JSON** — `extractJSON` tolerante + repetición con el error en el prompt.
- **Consumo de tokens en "next step"** — se genera al cerrar sesión y se cachea en `profile.json`.