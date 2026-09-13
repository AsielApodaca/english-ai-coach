# 001 · Coach core — Tareas

- [x] Scaffolding: package.json, tsconfig, .env.example, .gitignore, scripts/setup.sh
- [x] storage.ts: perfil + sesiones JSON (escritura atómica)
- [x] providers: zen.ts, gemini.ts, cloudflare.ts, ollama.ts, index.ts (extractJSON + fallback)
- [x] practice.ts: generación (JSON) + evaluación híbrida (word-match + LLM)
- [x] learner.ts: resumen del aprendiz + next step
- [x] whisper.ts: subprocess whisper-cli + detección de disponibilidad
- [x] server.ts: Express + endpoints API + subida WAV
- [x] public/: UI (Practice, Progress, Settings) + speech engines (TTS/STT/recorder)
- [x] Flujo completo "repeat after me" integrado
- [x] Tests: extractJSON, matchWords, storage, práctica mock
- [x] Prueba real: /api/health, /api/practice/new (LLM real), E2E en Chrome con ambos motores STT
- [x] Actualizar documentación (README) si aplica
- [x] Validar contra los criterios de aceptación de spec.md
- [x] Mover la feature a "Hecho" en ../../constitution/roadmap.md