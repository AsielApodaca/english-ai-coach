# 006 · Modo sin conexión total — Plan

## Enfoque

La arquitectura ya es módulos intercambiables con degradación (providers, STT, TTS). El modo offline se implementa como un **selector de escenario** (`OFFLINE_MODE=1` o `LLM_PROVIDER=ollama` + settings fijos): fuerza el stack local y excluye explícitamente los providers online de la cadena de fallback.

## Componentes

1. **Env / config** (`src/lib/providers/index.ts` + `.env`):
   - `OFFLINE_MODE=1` → `buildProviders` omite zen/gemini/cloudflare; la cadena queda solo `[ollama]`.
   - Sin `OFFLINE_MODE`, comportamiento actual (todo disponible según claves).
2. **Health** (`/api/health`): con `OFFLINE_MODE`, status solo de `ollama` + `whisper` + `piper`; agrega campos `offline: true` y `stack: { llm, stt, tts }` de disponibilidad; `notes` sin instrucciones de red.
3. **TTS **: depender de 007 — `speak()` usa Piper si está listo; en offline, si Piper falta, degrada a `speechSynthesis` del navegador (local, no red) con aviso en Settings.
4. **UI**: badge "Offline mode" en la barra; selector de proveedor limitado a Ollama; STT/TTS obligan whisper/Piper (con hint si falta).
5. **Setup** (`scripts/setup.sh`): agregar pasos opcionales `--offline` que instalan/verifican ollama (brew), whisper (ya), y piper (pipx) y descargan modelos.
6. **Verificación sin red**: script de prueba `npm run check:offline` que arranca el server con red bloqueada (p.ej. `Network Link Conditioner` o `pfctl`) y corre el flujo via HTTP; confirma 0 peticiones salientes.

## Decisiones

- **`OFFLINE_MODE` explícito** en vez de "detectar si hay red": más predecible y testeable; el detector de red es frágil.
- **Exclusión en `buildProviders`** (no en fallback): garantiza que ningún code path llame a un provider online.
- Los tests CI corren el flujo con un *fake* de red para no depender de connectivity conditioners en cada run.

## Riesgos

- **Modelo LLM no descargado**: `ollama pull llama3.1` no automatizado en runtime (requiere red una vez para bajar el modelo); el setup lo descarga la primera vez. Health debe distinguir "ollama up" vs "modelo presente".
- **Piper sin voz**: degradación a `speechSynthesis` (local) mantiene offline real.
- **whisper.large no aplicable**: con `OLLAMA` + whisper + piper, el mayor riesgo es RAM del modelo; documentar tamaños (llama3.1 8B ~5GB, whisper small ~180MB, piper ~50MB).