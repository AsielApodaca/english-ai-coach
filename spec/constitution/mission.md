# Misión

## Qué construimos

Asistente web local que entrena inglés técnico hablado mediante repetición guiada. La IA formula preguntas de entrevista y trabajo, divide una respuesta modelo en fragmentos y guía al usuario a repetirlos, evaluando su producción hablada, corrigiendo errores y recordando su progreso para planificar el siguiente paso.

1. **Flujo "Repeat after me"** — la IA lee la pregunta, dice el fragmento, espera la repetición del usuario y la evalúa para pasar al siguiente fragmento.
2. **Evaluación con memoria** — la transcripción se puntúa (0-100), se corrigen errores (gramática, vocabulario, fluidez, pronunciación) y los errores se registran en el perfil del aprendiz.
3. **Progreso adaptativo** — la IA conoce prácticas pasadas y debilidades, ajusta dificultad y dictamina el siguiente paso de aprendizaje.

## Para quién

- Un ingeniero de software recién egresado que quiere mejorar su inglés técnico hablado para el trabajo y entrevistas.
- Usuario único, personal, en macOS con Node 26 y presupuesto $0 (solo LLMs gratuitos).

## Principios

- **Costo cero** — solo se usan LLMs, STT y TTS gratuitos o locales; nada de suscripciones.
- **Cero fricción** — la app debe funcionar con la configuración ya existente del equipo (llave de OpenCode Zen) sin pasos extra para el caso principal.
- **Memoria como primera clase** — ninguna interacción importante ignora el historial; el perfil del aprendiz se incluye en generación y evaluación.
- **Local y privado** — los datos de práctica viven en `data/` (JSON local), fuera de git; el audio no se persiste.
- **Extensible** — los proveedores LLM son intercambiables (interfaz común + fallback).

## Qué NO es

- No es una app móvil ni de escritorio empaquetada; es una web local servida en localhost.
- No hace evaluaciones de pronunciación por fonética/audio; usa STT (transcripción) para inferir acierto y calidad.
- No vende ni comparte el progreso; no tiene backend en la nube ni base de datos remota.
- No es un curso; es un tutor de práctica hablada.