# 007 · Voz humana (TTS neural local)

**Estado:** backlog (no iniciado)

## Qué hace

La voz de la IA deja de sonar robótica ("Loquendo"/`speechSynthesis` del navegador). En producción se usa una voz neural natural generada en local con **Piper** (WAV que se reproduce en el navegador), con control de prosodia, velocidad y pausas. Si Piper no está instalado, degrada a **edge-tts** (online); `speechSynthesis` queda solo como último recurso.

## Por qué

La misión define la voz como el canal principal de la app: "Habla primero" y "Naturalidad conversacional". Un tutor hablado con voz robótica rompe la inmersión y la naturalidad; la voz humana es parte del producto.

## Criterios de aceptación

- [ ] El flujo completo (fragmentos, preguntas, correcciones, conversación 003) reproduce con voz neural Piper por defecto.
- [ ] Piper instalado localmente (subprocess `piper`, modelo EN claro); sin dependencias npm nuevas.
- [ ] Pausas y velocidad controladas: "Repeat after me" + fragmento con silencio medido (Piper con `length_scale` para ritmo y silencio entre frases sin exponer hacks al frontend).
- [ ] Si Piper falta: degrada a edge-tts (online); si tampoco: `speechSynthesis` del navegador.
- [ ] Estado de TTS (motor activo / disponible) visible en Settings, como whisper.
- [ ] Cambio de vocalizador sin tocar la orquestación del flujo (misma interfaz `speak(text)`, que hoy ya hay).

## Fuera de alcance

- Clonación de voz del usuario; voces con emoción/tono por estado de ánimo.