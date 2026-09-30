# 110 · Chime de acierto y avance directo al siguiente fragmento

**Estado:** especificado 📋 (ola 7 — pendiente de implementar)

## Contexto

- Caso de uso: CU2, pasos 11–12 (feedback de fragmento → siguiente fragmento), 18–20 (cierre) y flujo alternativo de reintento (`../../use-cases/CU2.md`).
- Pantallas: karaoke (`../../design/screens.md` §2; `../../design/design-system.md` componente 1 "letra karaoke" + "Phonetic Feedback Chips").
- Base:
  - `src/lib/cu2.ts` — máquina de estados pura: `buildFeedbackText(outcome)` (locución de pass/fail), `onFeedbackTtsEnd` (transición que dispara el avance de fragmento), `buildNoSpeechText()`.
  - `public/ui/practice-view.js` — loop de fragmentos (habla → captura → `renderFeedback` → `speak(coachLine)` → `fi++` si pasó) y bloque de respuesta completa (mismo patrón).
  - `public/speech/browser-tts.js` — `BrowserTTS.speak()` (capa server `/api/tts` → fallback browser).
- Decisiones registradas (sesión de especificación):
  - Efecto de acierto = **chime sintetizado con Web Audio API** (sin assets de audio en el repo).
  - Alcance: **fragmentos de repetición Y respuesta completa** (consistencia en todo paso aprobado).

## Qué hace

Hoy, cuando la evaluación aprueba (`score >= passThreshold`), el coach **locuta** una línea de enhorabuena (`"Great job! That was N percent accurate."` + tip) y solo después avanza. Esta feature reemplaza esa locución por un **efecto de sonido corto y sintetizado (chime)** que simboliza "correcto", e inmediatamente después el coach lee el siguiente fragmento **sin ninguna frase introductoria** (sin "Great job…", sin "Repeat after me", sin "Let's continue"), es decir, va directo al grano.

## Por qué

Cada aprobación cuesta hoy ~3–5 s de locución de relleno que rompe el ritmo de práctica. El refuerzo positivo es mejor como señal sonora corta e inmediata (menos latencia percibida, más repeticiones por sesión) y la lectura del fragmento debe ser exactamente el fragmento para que el usuario asocie "escuchar → repetir" sin ruido verbal intermedio. Además se fija un **invariante anti-regresión**: el texto que llega al TTS para un fragmento es verbatim el fragmento, para que frases como "repeat after me" no puedan volver a aparecer por una refactor futura.

## Requerimientos funcionales

- [ ] **Módulo de chime:** nuevo módulo `public/speech/chime.js` con API pura/prueba (`playChime({ kind, volume, signal? }) → Promise<void>`). Sintetizado con Web Audio API (`OscillatorNode` o `AudioBuffer` generado): tono/doble-tono tipo "ding" suave, ataque corto, decaimiento con fade-out, duración total ≤ 300 ms, sin archivos `.mp3`/`.wav` en el repo.
- [ ] **Acierto sin locución:** cuando `outcome.passed === true` (fragmento **o** respuesta completa), el cliente **no** llama `speak(coachLine)`; en su lugar reproduce el chime. El chip visual de feedback (`renderFeedback`: "Buen flujo · N%") **se mantiene sin cambios**.
- [ ] **Secuencia sin solape:** orden normativo `renderFeedback → await playChime() → speakWithKaraoke(siguiente fragmento)`. El chime nunca se superpone al TTS del coach ni al del usuario.
- [ ] **Directo al grano (invariante verbatim):** todo texto enviado al TTS para leer un fragmento debe ser **exactamente** `fragment.text` (`inputAlTts === textoDelFragmento`), sin prefijo ni sufijo. Cubre: primer fragmento del loop, fragmento siguiente a un acierto, y reintento tras fallo (ahí sí se permite la locución de feedback **antes** de releer el fragmento, pero la releitura en sí sigue siendo verbatim).
- [ ] **Fallo intacto:** si `outcome.passed === false`, comportamiento actual sin cambios: se locuta `coachLine` (feedback con tips de `buildFeedbackText` rama fail) y se relee el **mismo** fragmento. El caso no-speech (`buildNoSpeechText`) también conserva su locución.
- [ ] **Respuesta completa:** pass → chime → cierre de sesión (panel "hacer otra práctica") **sin** locución de enhorabuena; fail → feedback hablado + reintento (sin cambios).
- [ ] **Cancelación:** el chime obedece al mismo token/generación de flujo que el TTS (`cancelFlow`/token de `speak`); al cancelar la sesión en mitad de un chime, este se detiene y no arranca ninguna lectura posterior.
- [ ] **Volumen:** el gain del chime aplica el setting de volumen del coach (mismo clamp/floor que `volumeSetting()`), para que bajar la voz del coach baje también el chime.
- [ ] **Reductor canónico alineado:** `src/lib/cu2.ts` actualiza la regla de avance: en el path de pass, el evento que dispara `onFeedbackTtsEnd` pasa a ser el **fin del chime** (nuevo evento del reducer, p. ej. `CHIME_END`, o bien el cliente sintetiza el mismo efecto emitiendo `TTS_END` tras el chime — elegir uno y mantener reducer y vista consistentes). La fase `feedback` no debe quedarse colgada si el chime no llega a sonar (timeout defensivo).
- [ ] **Contrato de API intacto:** el server puede seguir devolviendo `coachLine` en el path de pass (compatibilidad con resume/históricos); la decisión de no locutarlo es **del cliente**. Ningún endpoint cambia su shape.
- [ ] **Sin llamadas de red** para el chime y sin dependencias npm nuevas.

## Requerimientos no funcionales

- Overhead por acierto ≤ 300 ms (frente a ~3–5 s de locución actual).
- Cero assets de audio; el módulo del chime es autosuficiente (≤ ~60 líneas).
- Funciona con cualquier motor TTS activo (Piper/edge/browser) porque no comparte cadena con TTS.

## Decisiones de diseño / tecnología

- **Chime sintetizado vs asset de audio:** elegido sintetizado — cero binarios en el repo, parámetros ajustables, testeable en Node sin fixtures de audio. Alternativa descartada: `.mp3` incluido (peso + licencia + gestión de assets).
- **Dónde vive la decisión de no locutar:** en el cliente (practice-view), no en el server — evita romper el contrato de `coachLine` y el histórico de intentos persistidos. Alternativa descartada: eliminar `coachLine` de pass en `cu2.ts` (rompería tests y consumidores existentes).
- **"Repeat after me":** hoy ningún caller envía `segments` al `/api/tts` (la capacidad existe sin uso), pero se fija el invariante verbatim como red de seguridad ante refactorizaciones.
- **Evento de avance:** preferible un evento explícito (`CHIME_END`) en el reducer sobre reutilizar `TTS_END` encubierto, para que la especificación pura refleje la realidad; si se elige `TTS_END`, documentarlo en el código como convención.

## Dependencias

- 105 (loop de fases karaoke) — modifica su camino de pass.
- 107 (siguiente pregunta) — el cierre con chime aplica también al final de pregunta en sesión continua.
- 001/007 (evaluación + TTS) — solo consumen, no se modifican.

## Criterios de aceptación

- [ ] `tests/chime.test.ts`: parámetros del chime (duración ≤ 300 ms, ramps de ataque/decaimiento, rango de frecuencias, gain clampado por el volumen del coach, kind pass vs fail-quieter si aplica).
- [ ] `tests/cu2.test.ts` actualizado: pass de fragmento → avanza al siguiente vía fin-del-chime; pass del último fragmento → fase `fullAnswer`; pass de full → `done`; fail → se permanece en `feedback` (reintento); cancelación durante `feedback` no deja la fase colgada.
- [ ] Test de invariante verbatim: para las ramas "primer fragmento", "avance tras pass" y "reintento", el string entregado a la capa TTS === texto del fragmento (sin prefijos/sufijos). Cubre el string hardcodeado duplicado del timeout en `practice-view.js` (verificar que también obedece la regla).
- [ ] `npm test` en verde y `npm run check` en verde (los archivos nuevos/afectados listados en `package.json` `check`).

## Checklist de verificación (pre-merge)

- [ ] Aprobar un fragmento → suena **solo** el chime y enseguida el siguiente fragmento, sin ninguna frase de enhorabuena ni "repeat after me".
- [ ] Aprobar la **respuesta completa** → chime + panel de cierre, sin locución de enhorabuena.
- [ ] Fallar un fragmento → feedback hablado con tips y relectura del mismo fragmento (regresión verificada).
- [ ] Chip visual de feedback se muestra igual que antes en pass y fail.
- [ ] Cancelar la sesión (`cancelFlow`) justo cuando suena el chime → silencio, no arranca lectura posterior, orb/dock en reposo.
- [ ] Cambiar el volumen del coach → el chime respeta el nuevo volumen.
- [ ] Flujo completo manual de una pregunta: fragmentos → full answer → cierre, sin textos "fantasma" hablados en ningún punto.
- [ ] Búsqueda de regresión: `grep -rn "Great job" public/ src/` — las únicas apariciones permitidas son la definición en `cu2.ts` (texto no locutado en pass) y su test; ninguna otra ruta lo reproduce.
- [ ] Resume de sesión a mitad de pregunta: el comportamiento de pass/fail tras reanudar sigue idéntico al descrito arriba.

## Fuera de alcance

- Cambiar el chip visual o el coloreado de palabras (105/106).
- Chimes diferenciados por score (p. ej. sonido distinto para 100%) o por tipo de error.
- Modificar `buildFeedbackText` (el texto fail se conserva tal cual).
- Animación/confetti de celebración.

## Recursos

- `src/lib/cu2.ts`, `public/ui/practice-view.js`, `public/speech/browser-tts.js`, `tests/cu2.test.ts`, `spec/use-cases/CU2.md` (pasos 11–12, 18).
