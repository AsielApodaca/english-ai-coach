# 007 · Voz humana (TTS neural local) — Plan

No iniciado. Ver spec.md.

Pre-nota de arquitectura: la app ya construye el texto y lo envía a `speak()` (hoy `speechSynthesis`). Para Piper se introduce un endpoint `/api/tts?text=` que genera WAV local y se reproduce vía `<audio>`; la interfaz `speak()` se mantiene igual y solo cambia el motor bajo el hood (misma regla de degradación que whisper/STT). Instalación: `pipx install piper-tts` + descarga del modelo EN (se incluye en `npm run setup` como paso opcional).