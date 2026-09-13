# 003 · Conversación hablada natural

**Estado:** backlog (no iniciado)

## Qué hace

La interacción deja de ser "escuchá la frase y repetila": pasa a ser una conversación viva, de ida y vuelta, con la IA como interlocutor humano. La IA habla (TTS), escucha (STT), responde con contexto y corrige sobre la marcha. La transcripción de lo dicho se muestra como subtítulo en vivo, no como el modo principal de uso.

## Por qué

El objetivo es que el usuario practique inglés técnico hablado como en una conversación real (entrevista, daily, charla laboral), no en modo de ejercicio. La naturalidad conversacional es lo que mide el mundo real y es la motivación central de la app, según la misión.

## Criterios de aceptación

- [ ] La IA guía el diálogo en turnos fluidos (habla → escucha → responde) sin botones de "repetir fragmento".
- [ ] La voz de la IA es neural y natural (feature 007), no `speechSynthesis` robótica.
- [ ] La IA responde según lo que el usuario dijo (contexto), hace follow-ups y aclaraciones como un humano.
- [ ] La transcripción del usuario se muestra como subtítulo en vivo mientras habla; la frase objetivo del coach también se muestra.
- [ ] Correcciones sobre la marcha: la IA interrumpe/aclara errores graves sin romper el flujo.
- [ ] Incluye el modo 'Interview' derivado: 4-6 preguntas encadenadas, follow-up, puntuación compuesta y transcript al terminar.
- [ ] El resultado se guarda como sesión y alimenta el perfil/next-step.
- [ ] Degrada con elegancia si STT/TTS del navegador no están disponibles (aviso claro).

## Fuera de alcance

- Puntuación por video/gestos; modo con límite de tiempo por pregunta.