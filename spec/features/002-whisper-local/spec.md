# 002 · Whisper local predeterminado

**Estado:** backlog (no iniciado)

## Qué hace

Hacer que whisper.cpp sea el motor STT por defecto cuando esté instalado, y que el navegador Web Speech actúe solo como fallback. Detectar instalación, descargar el modelo y exponer el estado en /api/health.

## Por qué

Sin credenciales, sin límites de peticiones, 100% offline y privado: las transcripciones nunca salen de la máquina. Mejor fidelidad para evaluación que el reconocimiento del navegador.

## Criterios de aceptación

- [ ] npm run setup && brew install whisper-cpp instala/descarga el modelo automáticamente.
- [ ] /api/health reporta whisper.available y modelReady reales.
- [ ] /api/transcribe WAV -> texto con whisper-cli; si el binario falta, error claro con instrucción.
- [ ] La UI muestra 'Whisper (local)' como motor seleccionable y lo marca como preferido cuando está listo.
- [ ] Web Speech queda como fallback automático si whisper falla o no está instalado.

## Fuera de alcance

['Mejora de precisión del modelo (elegir base/small/medium)', 'streaming de transcripción en tiempo real (solo a chunk final)']
