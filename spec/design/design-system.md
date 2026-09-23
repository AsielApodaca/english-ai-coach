# Design system — "Resonance Dark AI"

> Fuente: diseño oficial de las pantallas del proyecto "english ai coach" en Stitch (proyecto `projects/4993823217893855946`, design system "Resonance Dark AI" con variante FIDELITY). Este documento es el **referente normativo de la GUI nueva**. Los agentes desarrolladores deben reproducirlo con CSS puro en `public/styles.css` (sin Tailwind en producción).
>
> ⚠️ La marca "Vocalis AI" y los nombres de pantallas en los diseños son propuestas visuales del generador de diseño; el nombre oficial del producto es **English AI Coach**. Las tecnologías mostradas en las pantallas (WebGPU, ONNX en navegador, etc.) son **no oficiales** y no comprometen el stack real (ver `tech-stack.md`).

## Principios

1. **Darkroom acústico** — superficies profundas casi negras que eliminan fatiga visual en sesiones largas; solo los elementos semánticos de audio emiten color.
2. **Karaoke como metáfora central** — el texto de la respuesta se comporta como la letra de una canción sincronizada (Spotify lyrics): línea activa grande, líneas pasadas/futuras atenuadas, colores palabra a palabra según acierto fonético.
3. **Señal sobre forma** — los componentes no "se elevan" al interactuar; **se iluminan** (glows radiales de color). Cero sombras pesadas.
4. **Tri-tipografía** — Space Grotesk (display/letra de karaoke), Inter (diálogo/config), JetBrains Mono (IPA, timestamps, métricas técnicas).
5. **Colores semánticos quirúrgicos** — verde (maestría/acierto), cian (onda/audio activo), ámbar (corrección leve), carmesí (error fonético). Nunca decorativos en exceso.

## Tokens de color (CSS variables)

La paleta consolidada oficial (el diseño base genera variantes de surface/semantics por pantalla; acá se fija la que la app implementa):

| Token | Valor | Uso |
| --- | --- | --- |
| `--bg` (canvas) | `#0d0f12` | Fondo principal / viewport ("Level 0"). En algunas pantallas `#101319`. |
| `--panel` (Level 1) | `#16191f` | Sidebar, top bar, bandas laterales. Borde `1px rgba(255,255,255,.06)`. |
| `--panel-2` (Level 2) | `#1e222b` | Cards, bubbles activas, canvas waveform. Borde `1px rgba(255,255,255,.10)` + sombra `0 12px 32px -4px rgba(0,0,0,.5)`. |
| `--panel-3` (Level 3) | `#262b36` | Hover, segmented controls activos, modales. |
| `--border` | `#2b313e` | Bordes bajos de contraste (60–100% opacity). |
| `--text` | `#f8fafc` | Texto dominante / línea karaoke activa / transcript del usuario. |
| `--muted` (línea inactiva) | `#64748b` | Letra futura/pasada (40–50% presencia). |
| `--subtle` | `#475569` | Metadata, IPA, timestamps, hints. |
| `--accent` | `#10b981` | Acierto objetivo / verde feliz (también `#22c55e` en glow). |
| `--accent-cyan` | `#06b6d4` | Onda de audio, VU meter, estado de síntesis, active karaoke scrubber (también `#3b82f6`). |
| `--amber` | `#f59e0b` | Corrección leve (desviación fonética, prisa, syllable stress). |
| `--red` | `#ef4444` | Error fonético / miss / palabra no dicha. |
| `--surface-variant` | `#1e232d` | Dropzone, chips, contenedores auxiliares. |
| `--outline` | `#334155` | Línea de corte (dropzone dashed, controles ghost). |

> Estos tokens sustituyen/amplían los CSS vars actuales (`--bg, --panel, --text, --accent, --green, --amber, --red…`) manteniendo nombres compatibles hacia atrás para los módulos de voz (`speech/*`), que NO deben ser recoloreados acá.

## Tipografía

Token chart (fuentes cargadas desde Google Fonts como hoy):

| Role | Familia | Size / Weight / Line-Height | Letter-spacing | Uso |
| --- | --- | --- | --- | --- |
| Display hero | Space Grotesk 700 | 56px / 64px | -0.03em | Título máximo (poco usado) |
| Karaoke activa | Space Grotesk 700 | 40px / 52px (móvil 26px) | -0.02em | Línea de letra siendo repetida; escala 1.05 al activarse |
| Karaoke idle | Space Grotesk 600 | 32px / 44px (móvil 22px) | -0.01em | Líneas de letra inactivas (opacidad 0.35 + blur(1px)) |
| Headline lg | Space Grotesk 600 | 28px / 36px | -0.02em | Encabezados de pantalla |
| Headline md | Space Grotesk 600 | 22px / 30px | -0.01em | Títulos de card/sección |
| Body lg | Inter 400 | 16px / 24px | -0.005em | Diálogo, instrucciones |
| Body md | Inter 400 | 14px / 20px | 0 | Texto de config/settings |
| Body sm | Inter 400 | 12px / 16px | 0.01em | Metadata, hints |
| Label code | JetBrains Mono 500 | 13px / 18px | 0.02em | Chips técnicos, rutas, badges |
| Label phoneme | JetBrains Mono 600 | 15px / 20px | 0.04em | **Anotaciones IPA** sobre las palabras |

## Layout — "cockpit": sidebar full-height + columna de contenido

```
┌────────────┬───────────────────────────────────────────────────────────┐
│  Sidebar   │ Top bar (breadcrumb · toggle sidebar)                     │
│  280px,    ├───────────────────────────────────────────────────────────┤
│  full-     │                                                           │
│  height    │     Central stage (fluido ≤840px)                         │
│            │     dual-mode canvas: config o karaoke                    │
│  · brand   │                                                           │
│  (logo +   │                                                           │
│   title)   │                                                           │
│  · New     │                                                           │
│    Session │                                                           │
│  · Historial (Today/Yday/7 días)                                       │
│  · Footer: pill Speech Engine READY                                     │
│            fila usuario (avatar · Guest · ⚙ settings)                   │
└─────────┬──┴───────────────────────────────────────────────────────────┘
          └─ top bar y stage acompañan a la sidebar al colapsar/drawer
```

- **Sidebar izquierda (280px fija, full-height):** brand (logo `graphic_eq` + "English AI Coach") + botón colapso, botón *New Session* (⌘K), historial de sesiones (Today/Yesterday/Previous 7 Days), y footer con pill de estado del motor de voz ("Speech Engine · READY") arriba y fila de usuario (avatar, nombre —Guest por defecto—, engranaje de settings) debajo. Colapsa en desktop y se vuelve drawer off-canvas con backdrop en tablet/móvil (<1024px).
- **Top bar (48px, frosted, ancho adaptativo):** solo a la derecha de la sidebar; contiene el breadcrumb ("Studio / Config|Practice") y el toggle de apertura de la sidebar. `left: var(--sidebar-w)` en desktop con sidebar visible; `left: 0` cuando la sidebar está oculta o en tablet/móvil (la sidebar se superpone).
- **Central stage (fluido, max-width 840px):** el canvas dual — configuración (CU1) o práctica karaoke (CU2). Modo chatbot (reto futuro) o modos combinados.
- **Dock de audio (orb push-to-talk, waveform, tempo, VU meter):** **no pertenece al shell**; es componente de la vista de práctica (CU2, feature 105).
- **Panel derecho (opcional, 320px):** "IPA inspector" en modos avanzados (futuro con 004).
- Breakpoints: desktop >1024px (sidebar full-height colapsable; top bar la sigue); tablet 768–1023 (sidebar → drawer con backdrop, stage/top bar full width); móvil <767 (1 columna, letra karaoke compacta). UI de audio solo desde 105.

## Elevación y efectos

- Niveles por **capas cromáticas + backlight neón difusa**, no drops shadows.
- Level 0/1/2/3 como tabla de colores de arriba.
- Hook "reactivo sónico": cuando el usuario habla o la IA genera audio → glow radial:
  - Voz del usuario activa: `0 0 40px -10px rgba(6,182,212,.35)`.
  - Objetivo fonético superado: flash de borde transitorio `0 0 24px rgba(16,185,129,.4)`.
- Dock/Modales: translúcidos `rgba(22,25,31,.82)` + `backdrop-filter: blur(20px) saturate(180%)` + micro-glow border `1px rgba(6,182,212,.25)`.

## Shapes

- Contenedores y cards: `border-radius 12–16px` (0.75–1rem).
- Pills / nodos de audio / chips / state: `9999px`.
- Barras del waveform: micro-radios 2–4px.

## Componentes clave

### 1. Synchronized Lyrics Pronunciation Streamer (karaoke)
- Contenedor sin borde, auto-scroll vertical con máscaras CSS gradiente (`mask-image: linear-gradient(to bottom, transparent, black 15%, black 85%, transparent)`).
- Estados por línea: **past** `#475569` no interactiva; **current** `#f8fafc`, agrandada (escale 1.05), resaltado palabra por palabra; **future** `#64748b`, clickable (skip audio / re-prompt).
- Sub-sílabas con IPA inline encima de cada palabra mediante chiplets JetBrains Mono.

### 2. Audio Waveform & Presence Visualizer
- Canvas de 32 barras animadas vía Web Audio API.
- Idle: pulso suave slate `#334155`. IA hablando: onda senoidal cian `#06b6d4`. Usuario grabando: VU meter lima `#10b981` → ámbar `#f59e0b` si el volumen se dispara.

### 3. Push-to-Talk Orb & botones
- **Orb 64×64px** circular, default verde `#10b981` con ícono blanco; al presionar manda 2 anillos concéntricos expansivos `rgba(16,185,129,.3)`.
- Acciones secundarias: ghost buttons `#1e222b` + `1px rgba(255,255,255,.08)` + hover blanco brillante.

### 4. Audio & Script File Dropzone
- Borde dashed `2px dashed #2b313e` → cian al drag-over.
- Contenedor frosted oscuro con waveform placeholder + prompt "Drop any file here and add it to the conversation" / "Drop MP3, WAV, or drill text…".
- Chips de archivos adjuntos con ícono `attach_file`/`description` + nombre + botón quitar (×).

### 5. Phonetic Feedback Chips
- Micro-badges bajo palabras mal dichas.
- Estructura: lo dicho vs lo objetivo, p. ej. `[θ] not [s]` → rojo (`rgba(239,68,68,.15)` bg, texto carmesí) + flecha → verde (`rgba(16,185,129,.15)` bg).
- Ejemplo real en el diseño: `[ˌprɛ-] → /priː-/` y `[bɒt.əl.nek] → [ˈbɑːtlˌnɛk]`.

### 6. Session History Sidebar
- Agrupado por recencia: **Today / Yesterday / Previous 7 Days**.
- Cada entrada: título del tópico, level badge, conteo de ciclos de repetición completados, y anillo de progreso mini coloreado de carmesí→esmeralda según el score de pronunciación.
- Badge "ACTIVA (Q1)" en la sesión actual.

### 7. Estado del motor de voz
- Pill superior: "Whisper v3 Phonetic · READY" / "Vocalis Speech Engine · READY" / "AI Speech Engine · READY" (motor activo + estado instalado).

## Iconografía

- Family: **Material Symbols Outlined** (ya referenciada en los HTML de Stitch). Uso de glyphs: `graphic_eq` (logo/brand), `mic`, `settings`, `dock_to_right`, `terminal`, `add`, `cloud_upload`, `attach_file`, `volume_up`, `speed`, `replay`, `arrow_forward`, `expand_more`, `tune`, `record_voice_over`, `account_circle`, `badge`, `shield`, `lock`, `save`, `delete_sweep`, `preview`, `waves`, `palette`, `summarize`, `all_inclusive`, `trending_up`, `notifications_active`, `verified_user`, entre otros.
- En la web local se cargan vía CDN Google Fonts igual que las fuentes de letra.

## Estado visual de controles cantados

| Estado | Tratamiento |
| --- | --- |
| Botón start deshabilitado | Opacidad baja + `cursor: not-allowed`, sin glow |
| Start habilitado | Verde esmeralda con glow sutil |
| Grabando | Orb con anillos expansivos + VU meter cyan→lima→ámbar |
| IA hablando | Waveform senoidal cian |
| Palabra pasada correcta | Verde `#10b981` |
| Palabra leve | Ámbar `#f59e0b` |
| Palabra fallada/no dicha | Rojo `#ef4444` |

## Implementación

- Todo el styling vive en `public/styles.css` (CSS plano + variables), reemplazando el tema actual.
- Archivos nuevos de módulos UI se crean bajo `public/ui/` (componentes) — ver `101-frontend-shell`.
- La GUI nueva es una SPA: `index.html` reestructura el body al shell cockpit (sidebar full-height + columna de contenido); el JS de `app.js` se modulariza.
- Fuentes: mantener la carga actual de Google Fonts y añadir Space Grotesk + JetBrains Mono + Material Symbols.

## Elegibilidad / contraste

- Contraste texto sobre `--panel`: `#f8fafc` / `#16191f` cumple AA ampliamente. `--muted #64748b` para letra inactiva es intencionalmente bajo (solo texto auxiliar).
- Los colores de señal (verde/ámbar/rojo) nunca se usan para texto de lectura larga; solo marcado de palabras, chips y badges.