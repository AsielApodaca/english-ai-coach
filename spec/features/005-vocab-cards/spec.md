# 005 · Vocabulario técnico (repaso espaciado)

**Estado:** backlog (no iniciado) — en el roadmap v2 se ejecuta como modalidad "vocab" dentro del shell (`101`); fuente de gaps: `profile.vocabGaps` (alimentado por 105/106/practice).

## Qué hace

Tarjetas de repaso espaciado de los términos técnicos que el aprendiz falla o desconoce, derivadas de los gaps que ya detecta el learner (`profile.vocabGaps` = palabras olvidadas ≥2 veces y `weakErrors` recorrentes). Cada tarjeta incluye palabra, definición en contexto laboral, ejemplo, un fragmento corto para practicar en voz alta, y un intervalo SM-2 que se ajusta según el acierto. La app sugiere repasar la tarjeta debida desde el inicio.

## Por qué

Reutiliza datos que la app ya recoge sin costo (missing words en cada intento, categorías de error) para convertir pérdidas concretas en vocabulario dominado en contexto técnico. El repaso espaciado (intervalos crecientes) es el método con mejor evidencia de retención a largo plazo, y encaja con la memoria como primera clase.

## Criterios de aceptación

- [ ] Derivar tarjetas candidatas desde `profile.vocabGaps` (palabras olvidadas repetidamente) al terminar una sesión.
- [ ] Cada tarjeta contiene: palabra, definición en contexto técnico, ejemplo usado, y un fragmento corto para practicar en voz alta (con TTS).
- [ ] Repaso espaciado SM-2: intervalos crecientes (p. ej. 1, 2, 4, 7, 15, 30 días) y fecha de próxima revisión persistida.
- [ ] `GET /api/cards` devuelve la(s) tarjeta(s) vencidas; la pantalla de inicio sugiere repasar la debida.
- [ ] `POST /api/cards/review` con `{ correct }` actualiza el intervalo, `ease` y el breadcrumb de práctica (se guarda como sesión con la tarjeta).
- [ ] El acierto/fallo alimenta `updateProfile` (vocabGaps se limpian cuando la palabra deja de fallar).
- [ ] Si no hay gaps aún, no se muestra nada (la feature es pasiva hasta tener datos).

## Fuera de alcance

- TTS por tarjeta avanzado (usa el motor existente, 001/007).
- Sincronización multi-dispositivo (es single-user local).
- Algoritmo complejo (Anki full): SM-2 simplificado basta.