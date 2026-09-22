# Pantallas del diseño (Stitch) — descripción y uso

> Inventario de las pantallas del proyecto "english ai coach" (Stitch, project `projects/4993823217893855946`). Cada pantalla describe, en lenguaje de implementación, la estructura de UI que el frontend nuevo debe reproducir. La marca que aparece en los diseños ("Vocalis AI", "TechEnglish") es **no oficial**; el nombre del producto es **English AI Coach**.
>
> Fuente visual: descargable de Stitch. Para los agentes, la fuente normativa de texto/estructura es **este documento** más `ui-flow.md` y `design-system.md`.

## Índice de pantallas y recursos Stitch

| ID de pantalla | Nombre | Vista | En HTML descargado |
| --- | --- | --- | --- |
| `a75ca4c11b78459b932420a2f72c6fe7` | Configurar Sesión con AI Coach — Minimalist | visible | `config-session.html` |
| `26c911872fcf4fa7a781cb786229ac17` | Configurar Sesión con AI Coach (variante) | oculta | `hidden-config.html` |
| `ffb4dd13e7c44d5092d7b3b4323e2378` | Práctica en Vivo — Formato Letras Spotify (Flujo Continuo de Preguntas) | visible | `live-practice.html` |
| `1c6af75e5fac4d13bfe531f7dc945f2f` | Práctica en Vivo (Minimalist) | oculta | `hidden-practice-minimalist.html` |
| `04dc70c267c24840b84a7389d0a7ad3a` | Configuración General — Ajustes | visible | `settings.html` |
| `65831b66f6eb45439ac9848dda13d397` | Configuración — Entrenamiento & Pronunciación | visible | `training.html` |
| `1c146edbb6ec4fa2a2ef215d1fa368a1` | Configuración — Perfil & Datos | visible | `profile.html` |
| `8a75c21ad7a74d6ebe3c4f52cdbe13ea` | Configuración — Modelo IA Local | oculta | `hidden-model.html` |

Nota: los screenshots `hq-*.jpg` no son legibles por el modelo (sin soporte de imagen); usar `*.html` para extraer el contenido textual/estructural.

---

## 1. Configurar Sesión con AI Coach (CU1) — `a75ca4c…`

**Objetivo:** pantalla de configuración de CU1. Es el **home del producto** (se muestra al entrar al sistema, según CU3).

**Estructura de layout:**
- **Top bar:** logo/brand "Vocalis AI" (en producción "English AI Coach") + pill de estado del motor ("Speech Engine · READY") + acciones (nueva sesión ⌘K, ajustes ⚙, perfil).
- **Sidebar izquierda (historial):** agrupación Today / Previous 7 Days; cada item: título, score, level badge, anillo de progreso.
- **Central stage (config):**
  - Header "Iniciar nueva práctica" + breadcrumb.
  - **Instrucción de Rol para el AI Coach** (textarea de 2000 chars, contador `156/2000`): ejemplo del diseño — "Simula ser un Engineering Manager senior de Google realizando una entrevista técnica. Mi rol es el candidato. Hazme preguntas técnicas desafiantes…".
  - **Dropzone de archivos** (PDF/DOCX/TXT/MD): estado mínimo (drag), entrada con waveform + "Dead simple. Pick a file. Drop your PDF, docx, Txt, MD, or any other file. We handle the heavy lifting to turn it into context."
  - **Plantillas (template chips):** Mock Tech Interview · System Design Defense · Client Demo Pitch · Behavioral Leadership (al tappear, rellenan el textarea y el nivel).
  - **Nivel de inglés (dropdown A1–C2):** default **B2 (Working)**, con hint "≈ 94% match/accuracy histórico" (dato de perfil).
  - **Acento Objetivo:** "General American (US)".
  - **Foco Fonético:** chips `/θ/`, `/v/-/b/`, `/æ/` (derivados del perfil: `profile.focusPhonemes`).
  - **Bloque "Audio I/O":** micrófono (p.ej. `Rode NT-USB`, nivel `-14 dB`), botón "Prueba de sonido".
  - **Botón "Iniciar práctica":** deshabilitado → se habilita con texto+level.
- **Modal de lanzamiento "Iniciando Sala de Audio":** pasos "DSP 48kHz → Whisper Aligner → Role Topic" con botones **Cancelar** y **Entrar al Estudio** (o "Ingresar").
- **Shell dock inferior:** orb push-to-talk visibles también en config (estado idle).

**Mapeo:** feature `103-session-config-cu1`; dependencias 101/102/104.

---

## 2. Práctica en Vivo — Formato Letras Spotify (CU2) — `ffb4dd13…`

**Objetivo:** karaoke de práctica de CU2 con flujo continuo de preguntas (Q1→Q∞) — la vista de práctica en vivo.

**Estructura de layout:**
- **Top bar** resumida: "Junior SWE First Interview" (nombre actual) + pill "Speech Engine · READY"; botón "Finalizar Sesión".
- **Sidebar historial:** compacto; la sesión actual con badge **"ACTIVA (Q1)"** (número de pregunta en curso).
- **Central stage (karaoke):**
  - Chip de feedback del encabezado: "Buen flujo · Foco en /tʃ/ · 92%".
  - **Líneas de letra estilo Spotify:** la línea activa es la más grande y brillante; líneas siguiente/anterior más bajas y atenuadas; **anotación IPA palabra por palabra** sobre la línea activa (ej. `[maɪ] My`, `[ˈɡreɪtɪst] greatest`).
  - Subestrofa "Coach:" resaltada cuando el coach está hablando.
- **Dock inferior:**
  - Orb grabación (vivo), **waveform 32 barras**, mp anteparcial del transcript en curso de la IA.
  - Monitores: micrófono (`Rode NT-USB`, `-14 dB`), tempo (`0.75× / 1× / 1.25×`), VU meter.
  - Pills de asistencia: `Siguiente Pregunta (IA)` · `Reintentar fragmento` · `Finalizar Sesión`.

**Mapeo:** feature `105-karaoke-practice-cu2` (+ `107` para el flujo continuo Q1→Q∞). 

---

## 3. Configuración General — Ajustes — `04dc70c2…`

**Objetivo:** macro-área de "Settings" con navegación izquierda (sub-tabs). Columna izquierda: categorías (General, Entrenamiento & Pronunciación, Modelo IA Local, Perfil & Datos). La variante minimalist usa nav lateral.

**Contenido de la sub-tab General:**
- **Micrófono:** selector de input device + "prueba de sonido".
- **Volumen / prueba de audio.**
- **Interacción con el karaoke:**
  - "Mostrar anotación IPA debajo de la letra" (toggle).
  - "Avanzar automáticamente al siguiente fragmento" (toggle).
  - "Resaltado en vivo de errores mientras hablas" (toggle; requiere el motor de timestamps).

**Estructura:** listas de ajustes con títulos de sección, toggles switch, controles ghost.

**Mapeo:** feature `108-settings` (sub-tab General y Audio).

---

## 4. Configuración — Entrenamiento & Pronunciación — `65831b66…`

**Objetivo:** controla el pipeline de reconocimiento/evaluación y la dinámica de práctica.

**Contenido:**
- **Motor de reconocimiento:** selector de modelo (muestra "Whisper v3 Large Turbo" con indicador de concurrencia/confianza; en producción: submódulo de whisper (tiny…large) o Web Speech; feature `002`).
- **Rigor de evaluación (Escala L2 Rigor):**
  - `Flexible` (>65% F1) · `Balanceado` (>82% F1) · `Estricto` (>93% F1).
  - Slider/segmented control; el valor alimenta el umbral de pase de fragmento.
- **Sensibilidad a muletillas (filler sensitivity):** `Relajado` · `Moderado (2 por frase)` · `Sensible` · `Tolerancia Cero`.
- **Ritmo de práctica:** `0.75× / 1× / 1.25×`.
- **Flujo continuo (Q1→Q∞) con dificultad adaptativa:**
  - Toggle "Flujo continuo de preguntas hasta que pidas pausar".
  - Política: si las últimas 3 respuestas > 90%, sube el nivel/rigor un escalón (auto).
- **Tiempo de preparación:** `0s / 3s / 5s` (pausa con beep antes de que el coach lea el modelo del usuario).

**Mapeo:** feature `108-settings` (Entrenamiento & Pronunciación) y `107-continuous-session` (adaptativa).

---

## 5. Configuración — Modelo IA Local — `8a75c21a…` (hidden)

**Objetivo:** configuración de infraestructura local (LLM, whisper, alineador, storage).

**Contenido (referente de UI, tecnología NO oficial):**
- Selector LLM (`Command R7B Q4 K lone llama`, `Promptcaps-3b`, `qw3d`…), indicador "0.34 tokens/sec", memoria/disc laje, fallback/mezcla, builder de "hybrid".
- Whisper (model, memory use).
- Alineador fonético (Wav2Vec2/CTC), storage local (búsqueda universal, path, encrypted snapshots).
- Botones: Run Diagnostics, "Rebuild Inference Cache" al ~95%.

**Mapeo:** en producción estos ajustes mapean a provider config real (zen/gemini/cloudflare/ollama + whisper model + storage path). Feature `108-settings` (sub-tab Modelo) pero con **nombres reales del stack** (no los de este diseño).

---

## 6. Configuración — Perfil & Datos — `1c146edb…`

**Objetivo:** administrar el aprendiz (perfil) y los datos locales.

**Contenido:**
- **Persona:** avatar/identidad "Alex Rivera" + nivel objetivo + bio (muestra "842 tokens").
- **Prompt injection / system persona:** exposición editable del prompt del aprendiz idéntico al de producción.
- **Storage:** breakdown (conversations `/data/sessions`, exercises, cache artifacts), barra de espacio, botón "Export JSON" (`data/profile.json`).
- **Elementos P2P/LAN, WebGPU** del diseño = **no oficiales**; N/A en producción v1.

**Mapeo:** feature `108-settings` (sub-tab Perfil) + `102-session-model-v2` (export).

---

## Variantes ocultas

- `26c911872fcf4fa7a781cb786229ac17` Config alt — misma info de CU1 con menos chrome (sin sidebar visible), header "New Session".
- `1c6af75e5fac4d13bfe531f7dc945f2f` Práctica minimalist — idéntica a la visible sin sidebar (estado embebido).
- Valor: referencias de composición para responsive/colapso de sidebar.

## Screens → features

Toda pantalla de este inventario es implementada por las features del roadmap; las 108/109 son las mapeo, 105/103 las pantallas de práctica/config, y el layout común lo da `101-frontend-shell`.