# Misión

## Qué construimos

Asistente web local que entrena inglés técnico hablado como una conversación viva con su profesor. La IA habla con naturalidad humana, escucha al usuario, se adapta a lo que dice y lo corrige sobre la marcha. El usuario no "completa ejercicios": tiene una conversación hablada en inglés en la que la IA lo guía y evalúa. La transcripción de lo dicho se muestra como subtítulos (no es el centro de la interacción), y la pronunciación se evalúa también por análisis fonético del audio, no solo por la transcripción.

1. **Conversación hablada natural** — la IA habla (TTS), escucha (STT), responde de forma contextual y guía el diálogo como un humano lo haría: aclaraciones, correcciones sobre la marcha, turnos fluidos. La transcripción acompaña como subtítulo, no como modo de uso.
2. **Evaluación real de pronunciación** — además de la transcripción, se analiza el audio por fonética (fonemas, estrés, ritmo, entonación) para detectar y corregir pronunciación con precisión.
3. **Memoria y progreso** — la IA conoce prácticas pasadas y debilidades, ajusta dificultad y dictamina el siguiente paso de aprendizaje.

## Para quién

- Un ingeniero de software recién egresado que quiere mejorar su inglés técnico hablado para el trabajo y entrevistas.
- Usuario único, personal, en macOS con Node 26 y presupuesto $0 (solo LLMs gratuitos).
- Otros interesados: el autor de la app, que es también su usuario principal.

## Principios

- **Habla primero** — la voz es el canal principal: IA y usuario se comunican de forma hablada; el texto es soporte (subtítulos/transcripción), no el modo de interacción.
- **Naturalidad conversacional** — la IA actúa como un interlocutor humano: turnos fluidos, contexto, correcciones sobre la marcha; no como un reproductor "dice la frase / tú la repites".
- **Precisión fonética** — la pronunciación se evalúa por análisis de audio (fonemas, estrés, ritmo, entonación) y la transcripción se usa como complemento, no como única fuente.
- **Costo cero** — solo se usan LLMs, STT y TTS gratuitos o locales; nada de suscripciones.
- **Cero fricción** — la app debe funcionar solo con LLMs gratuitos (Gemini o Cloudflare) sin pasos extra para el caso principal.
- **Memoria como primera clase** — ninguna interacción importante ignora el historial; el perfil del aprendiz se incluye en generación y evaluación.
- **Local y privado** — los datos de práctica viven en `data/` (JSON local), fuera de git; el audio se procesa en local y no se persiste.
- **Extensible y modular** — los componentes son intercambiables (proveedores LLM, STT, motor fonético) y cada módulo puede usar la tecnología más adecuada (p. ej. Node para la app, Python para fonética/audio).

## Qué NO es

- No es una app móvil ni de escritorio empaquetada; es una web local servida en localhost.
- El texto no es el modo principal de uso: la conversación es hablada; el texto es transcripción de apoyo.
- No es un reproductor guiado de frases ("escucha la frase y repítela"); es una conversación con la IA.
- No vende ni comparte el progreso; no tiene backend en la nube ni base de datos remota.
- No es un curso; es un tutor de práctica hablada.