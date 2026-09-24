# Roadmap

Estado del producto English AI Coach (documento normativo de planificación). Features del rediseño GUI + UX (numeradas 101+) derivadas de los casos de uso (CU1–CU3 en `../use-cases/`) y de los diseños de pantalla en `../design/`.

## Hecho ✅

1. **001 · Coach core** — flujo completo "Repeat after me": generación de práctica, evaluación híbrida, memoria/progreso, TTS/STT browser y whisper opcional, fallback multi-proveedor LLM, UI en inglés local. *(Su UI será reemplazada por el shell v2; su motor de práctica/evaluación se reutiliza.)*
2. **002 · Whisper local por defecto** — whisper.cpp como motor STT predeterminado cuando está instalado (offline/privado; fallback automático a reconocimiento del navegador). *Se amplía en 106 con word-timestamps.*
3. **007 · Voz humana (TTS neural local)** — voz neural natural vía Piper local (`piper` subprocess, stdin), fallback a edge-tts online y `speechSynthesis` como último recurso; pausas medidas entre fragmentos y velocidad por `length_scale`; estado de TTS visible en Settings.
4. **101 · Frontend shell (cockpit + design system)** — rediseño total UI al layout de cockpit (sidebar full-height con brand/sesión/historial/footer, top bar a la derecha con ancho adaptativo, stage central, settings overlay). Implementa `spec/design/design-system.md`. Elimina la tab "Free chat" del MVP. *(Zonas del stage en placeholders; contenido llega con 103/105/109. La UI de audio —orb, waveform, tempo— no es de 101, es de 105/CU2.)*
5. **102 · Session model v2** — schema de sesión continua reanudable (`status: active|completed`, `questions[]`, `config` snapshot, nivel A1–C2 completo); migración de `data/sessions/*` (solo lectura, nunca reescribe v1); persistencia idempotente con escritura atómica y agrupación por recencia (Today/Yesterday/7 días) para historial; `title` derivado por LLM con fallback; `server.ts` adaptado al API v2 con wire-format v1 preservado.
6. **106 · Word timestamps (coloreado palabra a palabra)** — motor de coloreado: `transcribeWords` con `whisper-cli -oj -ml 1` (timestamps/offsets en ms tolerando shapes), `alignWords` determinista (LCS ponderada → green/amber/red, extras anexados al final, contracciones, forced-amber desde issues LLM), endpoint consolidado `/api/attempt` (transcribe+evalúa+alinea+persiste en un solo request), `/api/transcribe?words=true`, y `words[]` (con `startMs/endMs`) persistido en `attempts[].words` para reanudar sin re-transcribir. *(El render/pintado animado vive en 105; fallback sin whisper sigue el matching de 001.)*
7. **103 · Config de sesión (CU1)** — pantalla de configuración (home del producto): instrucción de rol (6000 chars con contador), template chips, nivel A1–C2 con default del perfil/B2, dropzone de contexto (104), acento + foco fonético desde el perfil, selector y prueba de micrófono con medidor dB, botón start gated, modal de lanzamiento "Iniciando Sala de Audio" (DSP 48kHz → Whisper Aligner → Role Topic) y `POST /api/session/start` que crea la sesión v2 + primera pregunta y navega a `#/practice/<id>`.
8. **104 · Ingesta de archivos de contexto** — dropzone PDF/DOCX/TXT/MD; `src/lib/extract.ts` (extracción TXT/MD directa, PDF vía `pdf-parse`, DOCX vía `mammoth` — única excepción a cero-deps), sanitización, límites (10 MB/archivo, 40k chars), `POST /api/files/extract` (base64 JSON por cero multipart-deps), persistencia en `data/tmp/context/` con `contextFiles[] {name,size,kind,textRef}` y bloque `DOCUMENT CONTEXT` para inyección en prompts; el archivo nunca sale al exterior.
9. **105 · Práctica karaoke estilo Spotify (CU2)** — flujo de fases: intro del coach → pregunta → respuesta modelo → loop de fragmentos (escucha-repite-colorea-feedback-reintento) → respuesta entera → cierre y "hacer otra práctica". Vista de letra sincronizada con IPA. Implementa `src/lib/cu2.ts` (máquina de estados pura + líneas habladas), `alignTextWords` (fallback textual green/red), endpoints `GET /api/session/:id` y `POST /api/session/checkpoint`, `POST /api/attempt` con `mode=text`/`full=1`/`passThreshold`/`coachLine`, dock de audio (orb/waveform/tempo) y vista karaoke en `public/ui/`.
10. **107 · Sesión continua Q1→Q∞** — flujo de preguntas continuo con dificultad adaptativa (rigor/ritmo suben si las últimas 3 respuestas >90%), tiempo de preparación (0/3/5s con beep), "Siguiente Pregunta". Implementa `src/lib/continuous.ts` (pure: `computeAdaptive` con clamps, `buildContextSummary`, `handleNextQuestionRequest` idempotente), `POST /api/session/next-question`, re-fetch de la última pregunta en `GET /api/session/:id`, badge "ACTIVA (Q{n})" en sidebar, beeps de preparación con WebAudio, pill de ajuste adaptativo y autoAdvance.
11. **108 · Settings en sub-tabs** — General & Audio, Entrenamiento & Pronunciación (rigor F1, muletillas, ritmo, adaptativa), Modelo IA (providers/motores reales del stack), Perfil & Datos (persona, prompt, export JSON). Precedencia sobre defaults; persiste a `data/profile.json`. Implementa `src/lib/settings.ts` (types/defaults/merge con precedencia snapshot>local>perfil>defaults), `POST /api/profile/settings` y `GET /api/storage`/`/api/export`, 4 sub-tabs ES modules en `public/ui/settings/` dentro del overlay de 101, IPA dictionary `public/ui/ipa.js` y prefs de dispositivo `engcoach.*`.

## Siguiente 🔜 (rediseño v2 — CU1/CU2/CU3)

La fase v2 se organiza en olas de implementación; cada ola es un PR independiente sobre la base previa:

### Ola 6 — Historial y reanudación (CU3)
12. **109 · Historial y reanudación (CU3)** — sidebar de sesiones agrupado (Today / Yesterday / 7 días) con score y badge "ACTIVA"; reanudar sesión activa; ver/sesiones completadas.

> Nota: **003 · Conversación hablada natural** queda **absorbida/superada** por 105 + 107 (el CU2 rediseñado es la conversación hablada del producto). Su texto histórico se conserva en `../features/003-spoken-conversation/` como referencia sin desarrollo activo.

## Backlog 💡

- **004 · Evaluación fonética por audio** — sidecar Python (parselmouth/librosa) que analiza fonemas, estrés, ritmo y entonación del audio. Feeds la precisión del ámbar/rojo de 106 y añade métricas reales de pronunciación; degrada a transcripción. *(Depende de 106; refina la feature, no la bloquea.)*
- **005 · Vocabulario técnico (repaso espaciado)** — tarjetas desde los gaps del perfil; práctica en voz alta con TTS de 001/007; modalidad "vocab" dentro del shell v2.
- **006 · Modo sin conexión total** — todo el flujo con Ollama + whisper.cpp (002) + Piper (007); por `OFFLINE_MODE` excluye proveedores web. *Requiere 002 y 007 (hechas).*
- **Coloreado en tiempo real exacto** — extensión de 106: marcado palabra a palabra mientras se habla (streaming de timestamps / alineador). Documentado como objetivo futuro.
- **Phoneme Metrics nav** — vista de métricas fonéticas agregadas del aprendiz (correla con 004).
- **Curriculum / decks de drills** — colecciones de práctica por tema en el sidebar.

## Regla de estado

- Un feature pasa a "Hecho ✅" cuando su `spec.md` está completo en estado `done`, sus criterios de aceptación pasan en tests y su implementación está en `main`.
- Al cerrar/PR completar una feature, actualizar `spec/features/<n>/spec.md` (estado y criterios) dentro de la misma rama/PR.