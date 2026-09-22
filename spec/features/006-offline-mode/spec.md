# 006 · Modo sin conexión total

**Estado:** backlog (no iniciado) — en el roadmap v2 se ubica tras `107/108` (la UI propone Ollama + whisper + Piper; `OFFLINE_MODE` también descarta los artefactos de `104` si no hay red para LLM).

## Qué hace

Que todo el flujo funcione 100% offline: Ollama (LLM) + whisper.cpp (STT) + Piper local (TTS). Ninguna petición de red sale del equipo: LLM a `localhost:11434`, STT a `whisper-cli` local, TTS a `piper` local. Depende de la feature 007 para el TTS local.

## Por qué

Es la garantía real de costo 0 ilimitado y privacidad total. Cloudflare/Gemini son gratis pero con topes diarios; local no tiene límites ni fugas de audio/texto.

## Criterios de aceptación

- [ ] Arranca y completa el flujo completo (nueva práctica, autoplay de fragmentos, grabación, evaluación, guardado de sesión) con `LLM_PROVIDER=ollama`, STT whisper y TTS Piper, sin ninguna clave de red usada.
- [ ] `/api/health` refleja: ollama detectado + modelo descargado; whisper ready; piper ready. Si falta algo local, el estado lo dice claro.
- [ ] El fallback de proveedores nunca selecciona un provider online cuando ollama local está up (modo offline forzado).
- [ ] No se filtra ninguna petición saliente en modo offline: bloquear proveedores web (zen/gemini/cloudflare) o verificar con red activa que no se les llama.
- [ ] El `setup` de 006 instala/pin del stack local completo (ollama + whisper + piper) de una pasada.
- [ ] La UI muestra indicador "Offline mode" y oculta/deshabilita opciones que requieren red.

## Fuera de alcance

- Optimización de rendimiento GPU de los modelos locales.
- Gestión de múltiples modelos GPU / descarga desde la UI.
- Sync con dispositivos remotos.