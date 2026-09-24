# 006 · Modo sin conexión total — Tareas

## Config / providers

- [ ] `OFFLINE_MODE=1`: `buildProviders` excluye gemini/cloudflare; cadena = `[ollama]`.
- [ ] `.env.example` documenta `OFFLINE_MODE=1` y stack local.
- [ ] `/api/health` con `offline: true` y `stack: { llm, stt, tts }`; sin instrucciones web.

## UI

- [ ] Badge "Offline mode" en la barra superior.
- [ ] Selector de proveedor limitado a Ollama en offline.
- [ ] STT/TTS forzados a whisper/piper con hint si falta (Settings).

## Setup / verificación

- [ ] `scripts/setup.sh --offline`: verificar/instalar ollama (brew) + modelo, whisper + modelo, piper + voz EN.
- [ ] `npm run check:offline`: arrancar server con red bloqueada, correr flujo vía HTTP, validar 0 peticiones salientes.

## Tests / cierre

- [ ] Tests `node:test` para `buildProviders` offline (solo ollama en lista) y status.
- [ ] Validar contra criterios de aceptación de spec.md.
- [ ] Mover la feature a "Hecho" en `../../constitution/roadmap.md`.