# 003 · Conversación hablada natural

**Estado:** hecho ✅ (rama `feature/spoken-conversation`)

## Qué hace

La interacción deja de ser "escuchá la frase y repetila": pasa a ser una conversación viva, de ida y vuelta, con la IA como interlocutor humano. La IA habla (TTS), escucha (STT), responde con contexto y corrige sobre la marcha. La transcripción de lo dicho se muestra como subtítulo en vivo, no como el modo principal de uso.

Sobre el chat libre existente (tab "Free chat", texto), añade modo hablado natural con turnos voz↔voz, correcciones en contexto e historial que alimenta la memoria del aprendiz. Incluye un modo 'Interview' derivado con preguntas encadenadas y puntuación compuesta.

## Por qué

El objetivo es que el usuario practique inglés técnico hablado como en una conversación real (entrevista, daily, charla laboral), no en modo de ejercicio. La naturalidad conversacional es lo que mide el mundo real y es la motivación central de la app, según la misión.

## Criterios de aceptación

- [x] Un botón de micrófono en la tab de chat convierte la conversación a hablada (habla → escucha → responde) sin "Repeat after me".
- [x] La respuesta de la IA se reproduce por TTS al terminar de escribir; mientras el usuario habla se muestra su subtítulo en vivo.
- [x] La voz de la IA es neural y natural (depende de la feature 007); si 007 no está, usa `speechSynthesis` sin romper.
- [x] La IA responde según lo que el usuario dijo (contexto), hace follow-ups y aclaraciones como un humano.
- [x] Correcciones sobre la marcha: el LLM detecta errores graves y los aclara sin romper el flujo; `extractJSON` tolerante igual que en 001.
- [x] El turno hablado funciona con Whisper local (preferido, feature 002) o browser STT como fallback.
- [x] Modo 'Interview' derivado: 4-6 preguntas encadenadas, follow-up según la respuesta, puntuación compuesta al terminar.
- [x] La conversación se guarda como sesión (reutiliza `Session`/`storage` y añade `turns`) y alimenta el perfil/next-step.
- [x] Degrada con elegancia si STT/TTS del navegador no están disponibles (aviso claro, el chat por texto sigue funcionando).

## Fuera de alcance

- Puntuación por video/gestos.
- Modo con límite de tiempo por pregunta.
- Clonación de la voz del usuario (ver 007).
- Streaming de transcripción en tiempo real de whisper (depende de la limitación de la feature 002).