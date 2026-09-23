# 103 · Config de sesión (CU1)

**Estado:** hecho ✅ (implementado en la rama `feature/session-config`, ola 3)

## Contexto

- Caso de uso: CU1 (`spec/use-cases/CU1.md`).
- Pantallas: `config-session.html` / `hidden-config.html` (IDs `a75ca4c11b78459b932420a2f72c6fe7`, `26c911872fcf4fa7a781cb786229ac17`); `screens.md` §1.
- Endpoints actuales relevantes: `/api/practice/new`, `/api/profile`.

## Qué hace

Implementa la pantalla de configuración (el home del producto — CU3 muestra CU1 al entrar). El usuario describe la conversación (instrucción de rol), elige nivel A1–C2 (default del perfil o B2), adjunta opcionalmente archivos (drag & drop global → 104), elige/verifica micrófono, y al cumplir el requisito (texto + nivel) se habilita "Iniciar práctica". El start dispara el **modal de lanzamiento** ("Iniciando Sala de Audio": DSP 48kHz → Whisper Aligner → Role Topic) y, al "Entrar al Estudio", crea la sesión v2 (`102`) y navega a la práctica (105).

## Por qué

El diseño y CU1 definen que la configuración es el punto de entrada de toda sesión; la generación libre vía "instrucción de rol" reemplaza el selector rígido de categoría/nivel de la UI v1 por control expresivo del tópico + personalización desde el perfil.

## Requerimientos funcionales

- [ ] **Textarea de instrucción** (límite 6000 chars, contador `N/6000`). ejemplo pre-cargado por defecto (copy del diseño): rol, contexto, expectativa del coach.
- [ ] **Template chips** (4): Mock Tech Interview · System Design Defense · Client Demo Pitch · Behavioral Leadership. Al hacer clic, rellenan textarea + nivel predefinido.
- [ ] **Dropdown nivel A1–C2** con etiquetas CEFR (A1 Starter … C2 Mastery); default: `profile.level` o `B2 (Working)`; muestra hint de accuracy histórico si existe.
- [ ] **Adjuntar archivos** PDF/DOCX/TXT/MD: botón de attach en el prompt box o **drag & drop en cualquier parte de la pantalla** (overlay que oscurece el fondo con instrucción de soltar); chips removibles con estado de extracción; integra con 104.
- [ ] **Acento objetivo** (default "General American (US)") y **foco fonético** (chips desde `profile.focusPhonemes`, p. ej. `/θ/`, `/v/-/b/`, `/æ/`) — alimentan la `config` (102).
- [ ] **Bloque Audio I/O:** selector de input device (Web Audio), monitor de nivel (dB) y botón "Prueba de sonido" que reproduce un tono y lo captura (usa el pipeline de audio de 105).
- [ ] Botón "Iniciar práctica": **deshabilitado** hasta que `topicPrompt` tenga texto y `level` válido.
- [ ] Al presionarlo: guarda borrador de config en estado local (se pierde si se cancela), muestra **modal "Iniciando Sala de Audio"** con pasos animados (DSP 48kHz → Whisper Aligner → Role Topic) y botones **Cancelar** / **Entrar al Estudio**.
  - Vía backend: la comprobación de disponibilidad (whisper instalado, TTS disponible) se resuelve en el STEP 2; si whisper no está, el modal anuncia el fallback (Web Speech) en el paso del aligner.
- [ ] "Entrar al Estudio" → `POST /api/session/start` (wrap de createSession + primera pregunta) que devuelve `{ sessionId, firstQuestion }` y navega a `#/practice/<id>`.
- [ ] CU3: no se crea sesión si nunca se presiona "Iniciar práctica".

## Requerimientos no funcionales

- El textarea no hace autosave por cada tecla (aunque sí a `data/tmp/` draft si se cancela y desea retomar — ver 109).
- Generación de la primera pregunta: se hace al "Entrar al Estudio" (loading state en modal), no antes.

## Decisiones de diseño / tecnología

- La generación de pregunta/contexto reusa el motor `practice.ts` con la instrucción de rol como `context`, en vez del viejo selector de categoria.
- El enum de nivel pasa a `LevelA1..C2` en tipos (`practice.ts`/`types`).
- Nivel de complejidad del topicPrompt: se pasa al LLM con "Learner memory" obligatoria (`learner.ts`) y la instrucción como system persona (convención tech-stack).

## Dependencias

- 101 (shell), 102 (session), 104 (files extract). 105 provee endpoint de pregunta.

## Criterios de aceptación

- [x] Start habilitado solo con topic + level; verificado por test de UI/DOM y por backend (`session/start` rechaza sin config).
- [x] Modal de lanzamiento muestra estado de motores (whisper ready o fallback).
- [x] Crear una práctica desde la config crea sesión v2 y navega a `#/practice/<id>` sin reload.
- [x] `npm test` y `npm run check` pasan.

## Fuera de alcance

- Procesar los archivos (104). La práctica en sí (105). Historial/resume (109). Settings (108).

## Recursos

- `spec/use-cases/CU1.md`, `spec/design/screens.md` §1, `spec/design/design-system.md` (componente dropzone/chips/modales), `src/lib/practice.ts`, `src/server.ts`.