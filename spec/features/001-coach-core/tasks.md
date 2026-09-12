# 001 · Coach core — Tareas

- [ ] Scaffolding: package.json, tsconfig, .env.example, .gitignore, scripts/setup.sh
- [ ] storage.ts: perfil + sesiones JSON (escritura atómica)
- [ ] providers: zen.ts, gemini.ts, cloudflare.ts, ollama.ts, index.ts (extractJSON + fallback)
- [ ] practice.ts: generación (JSON) + evaluación híbrida (word-match + LLM)
- [ ] learner.ts: resumen del aprendiz + next step
- [ ] whisper.ts: subprocess whisper-cli + detección de disponibilidad
- [ ] server.ts: Express + endpoints API + subida WAV
- [ ] public/: UI (Practice, Progress, Settings) + speech engines (TTS/STT/recorder)
- [ ] Flujo completo "repeat after me" integrado
- [ ] Tests: extractJSON, matchWords, storage, práctica mock
- [ ] Prueba real: /api/health, /api/practice/new (LLM real), E2E en Chrome con ambos motores STT
- [ ] Actualizar documentación (README) si aplica
- [ ] Validar contra los criterios de aceptación de spec.md
- [ ] Mover la feature a "Hecho" en ../../constitution/roadmap.md