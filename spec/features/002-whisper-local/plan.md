# 002 · Whisper local predeterminado — Plan

## Enfoque

Aprovechar el pipeline whisper ya construido en 001 (setup.sh, `src/lib/whisper.ts`, `/api/transcribe`, `recorder-wave.js`) y cerrar las tres brechas de "predeterminado":
1. **Auto-selección** en el frontend: al cargar `/api/health`, si `whisper.available && modelReady`, setear `settings.stt = "whisper"` como default salvo que el usuario haya elegido explícitamente otra opción.
2. **Fallback automático**: si `startRecording()` con whisper no puede transcribir (`/api/transcribe` devuelve error), degradar a BrowserSTT en ese intento y avisar una sola vez.
3. **Settings**: etiquetar la opción Whisper como *preferido* cuando está listo y mostrar el hint de instalación cuando no.

## Implementación

1. **Frontend — default**: en el handling del health check (`public/app.js`), guardar la elección previa del usuario (`localStorage engcoach.stt`); si no hay elección y whisper está listo, usar `stt = "whisper"`. Si ya hay elección, respetarla.
2. **Frontend — fallback**: envolver el flujo whisper (`btn-stop` → `/api/transcribe`) en try/catch; ante error de red/servidor, crear `BrowserSTT` y pedir el intento de nuevo, mostrando "Whisper unavailable — using browser recognition" una vez por sesión (`sess.whisperWarned`).
3. **Frontend — status**: en `Settings`, si `whisperOk`, mostrar "Preferred — local & offline"; si no, "Not installed — brew install whisper-cpp, then npm run setup".
4. **Tests** en `node:test`: correr `/api/whisper/status` en un server de prueba; evaluar la lógica de default (mock de `health`) con un helper puro `pickStt(health, userChoice)`.

## Decisiones

- **Default solo si no hay elección previa** — respeta al usuario que eligió browser, pero adopta whisper para el caso principal.
- **Fallback por intento, no por sesión** — cada grabación decide; si whisper vuelve a estar disponible, se usa de nuevo.
- **Sin streaming**: la transcripción se hace sobre el WAV completo al soltar el botón; el streaming queda fuera (ver spec).

## Riesgos

- **Whisper instalado pero modelo no descargado**: `/api/transcribe` descarga el modelo bajo demanda (ya implementado) y responde "Model downloaded. Please record again." El fallback no debe dispararse en ese caso; solo ante errores de red/transcripción.
- **Perf de ScriptProcessor**: es el enfoque actual; no se cambia en esta feature (fuera de alcance).