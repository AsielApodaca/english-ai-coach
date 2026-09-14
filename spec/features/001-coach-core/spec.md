# 001 · Coach core

**Estado:** implementado ✅

## Qué hace

El usuario abre la app web local y elige una categoría (Entrevistas, Método STAR, Daily standup, Tema libre) y un nivel. La IA genera una pregunta típica y una respuesta modelo dividida en fragmentos cortos. Por cada fragmento la IA lee "Repeat after me" más el fragmento, hace una pausa, y el usuario lo repite. La IA transcribe lo dicho, lo puntúa, lo corrige y decide si pasar al siguiente fragmento o pedir nuevo intento. Al completar todos los fragmentos, el flujo permite repetir/recordar la respuesta completa con feedback consolidado.

La app recuerda el progreso: temas practicados, errores frecuentes y nivel estimado se guardan y se inyectan en la generación/evaluación para personalizar la práctica y sugerir el siguiente paso.

## Por qué

Permite practicar respuestas de entrevista y lenguaje técnico hablado de forma guiada y con feedback inmediato, sin costo. La memorización incremental (fragmento a fragmento) y el seguimiento del progreso hacen el aprendizaje efectivo y motivador.

## Criterios de aceptación

- [x] `npm start` levanta el servidor y la UI responde en http://localhost:3000.
- [x] `/api/health` reporta estado de la llave LLM y de whisper (instalado o no) sin expirar secretos.
- [x] El usuario puede iniciar una práctica (categoría + nivel) y la app muestra pregunta + fragmentos.
- [x] TTS (botón Play) lee "Repeat after me" + fragmento con pausa; el texto del fragmento se muestra en pantalla.
- [x] STT (botón Record) captura la voz: funciona con Chrome Web Speech por defecto y muestra la transcripción en vivo.
- [x] `/api/evaluate` devuelve score (0-100), palabras faltantes, issues categorizados (grammar, word-choice, fluency, pronunciation) y sugerencias.
- [x] Un fragmento aprobado (≥70) avanza al siguiente; uno reprobado ofrece "Try again" con correcciones.
- [x] Al terminar, se guarda la sesión en `data/sessions/` y se actualiza el perfil (`data/profile.json`).
- [x] `/api/profile` y `/api/next-step` devuelven progreso por categoría, tendencia, debilidades y un plan de siguiente paso generado por LLM con memoria.
- [x] El selector de proveedor LLM (Zen / Gemini / Cloudflare / Ollama) es funcional y el fallback automático cambia de proveedor si el principal falla.
- [x] La UI está en inglés.
- [x] Seleccionar Whisper local como motor STT muestra estado "not installed" con instrucciones si falta (`brew install whisper-cpp`).

## Fuera de alcance

- Evaluación fonética de pronunciación (solo basada en transcripto por STT).
- Modo entrevista simulada completa (feature 003).
- Despliegue a la nube (es local).