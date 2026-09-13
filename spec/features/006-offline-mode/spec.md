# 006 · Modo sin conexión total

**Estado:** backlog (no iniciado)

## Qué hace

Que todo el flujo funcione offline con Ollama (LLM) + whisper.cpp (STT) + Piper local (TTS): ninguna petición sale del equipo. Depende de la feature 007 para el TTS local.

## Por qué

Es la garantía real de costo 0 ilimitado y privacidad total. Cloudflare/Gemini son gratis pero con topes diarios; local no tiene límites.

## Criterios de aceptación

- [ ] Arranca y completa el flujo completo con LLM_PROVIDER=ollama y STT whisper, sin ninguna clave de red.
- [ ] Ollama detectado y comunicándose con un modelo descargado; /api/health lo refleja.
- [ ] El fallback a llama-3.1 (u otro) funciona con insuficientes params de voz.
- [ ] No se filtra ninguna petición saliente (verificar sin red activa).

## Fuera de alcance

['Optimización de rendimiento GPU', 'gestión de modelos multi-GPU']
