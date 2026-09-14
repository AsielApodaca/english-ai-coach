# Roadmap

## Hecho ✅

1. **001 · Coach core** — flujo completo "Repeat after me": generación de práctica, evaluación híbrida, memoria/progreso, TTS/STT browser y whisper opcional, fallback multi-proveedor LLM, UI en inglés local.

## Siguiente 🔜

2. **002 · Whisper local por defecto** — whisper.cpp como motor STT predeterminado cuando esté instalado (offline/privado; fallback a reconocimiento del navegador).
3. **003 · Conversación hablada natural** — la interacción pasa de "escuchá la frase y repetí" a una conversación viva con la IA: habla, escucha, responde con contexto y corrige sobre la marcha; la transcripción acompaña como subtítulo, no como modo de uso. (Renombrada desde "Entrevista simulada".)
4. **004 · Evaluación fonética por audio** — sidecar Python (parselmouth/librosa) que analiza fonemas, estrés, ritmo y entonación del audio; fallback a evaluación por transcripción si no está disponible. Renombra "Pronunciación por sílabas".
5. **005 · Vocabulario técnico (repaso espaciado)** — tarjetas desde los gaps detectados en el perfil.
6. **006 · Modo sin conexión total** — todo el flujo con Ollama + whisper.cpp, sin ninguna petición saliente.
7. **007 · Voz humana (TTS neural local)** — reemplazar `speechSynthesis` del navegador (robótica, tipo Loquendo) por voz neural natural vía Piper local (fallback a Edge TTS), con prosodia/pausas controladas.

## Backlog / ideas 💡

- **Subtítulos coloreados** — la frase objetivo del coach en un color y las palabras mal dichas del usuario en rojo. (Parcialmente adelantado en el frontend como subtítulos de conversación.)