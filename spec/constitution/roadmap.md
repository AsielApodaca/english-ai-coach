# Roadmap

## Hecho ✅

1. **001 · Coach core** — flujo completo "Repeat after me": generación de práctica, evaluación híbrida, memoria/progreso, TTS/STT browser y whisper opcional, fallback multi-proveedor LLM, UI en inglés local.
2. **002 · Whisper local por defecto** — whisper.cpp como motor STT predeterminado cuando está instalado (offline/privado; fallback automático a reconocimiento del navegador).
3. **007 · Voz humana (TTS neural local)** — voz neural natural vía Piper local (`piper` subprocess, stdin), fallback a edge-tts online y `speechSynthesis` como último recurso; pausas medidas entre fragmentos y velocidad por `length_scale`; estado de TTS visible en Settings.

## Siguiente 🔜

4. **003 · Conversación hablada natural** — la interacción pasa de "escuchá la frase y repetí" a una conversación viva con la IA: habla, escucha, responde con contexto y corrige sobre la marcha. **Depende de 002 (STT whisper) y 007 (voz neural).** (Renombrada desde "Entrevista simulada".)
5. **004 · Evaluación fonética por audio** — sidecar Python (parselmouth/librosa) que analiza fonemas, estrés, ritmo y entonación del audio. Reusa `whisper-cli` de la 002 con `-jt` (word timestamps); degrada a transcripción. (Renombrada desde "Pronunciación por sílabas".)
6. **005 · Vocabulario técnico (repaso espaciado)** — tarjetas desde los gaps detectados en el perfil; la práctica en voz alta usa el TTS de 001/007.
7. **006 · Modo sin conexión total** — todo el flujo con Ollama + whisper.cpp (002) + Piper (007); por `OFFLINE_MODE` excluye proveedores web. **Requiere 002 y 007 hechas.**

## Backlog / ideas 💡

- **Subtítulos coloreados** — la frase objetivo del coach en un color y las palabras mal dichas del usuario en rojo. (Parcialmente adelantado en el frontend como subtítulos de conversación.)