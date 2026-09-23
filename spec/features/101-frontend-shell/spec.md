# 101 · Frontend shell — cockpit + design system

**Estado:** done ✅ (implementado en rama `feature/frontend-shell`)

## Contexto

- Casos de uso: transversal (base de CU1/CU2/CU3).
- Pantallas de diseño: todas (`spec/design/screens.md`).
- Referencia visual normativa: `spec/design/design-system.md` ("Resonance Dark AI").

## Qué hace

Reestructura el frontend de la app de la barra con tabs (Practice/Chat/Progress/Settings) a una **SPA tipo "cockpit de estudio"**: top bar (brand, status de motores, acciones globales), **sidebar izquierda de historial** (280px, colapsable), **central stage** (canvas dual config/práctica), panel derecho opcional (IPA inspector, futuro) y **dock inferior flotante** (push-to-talk, waveform, tempo, VU meter). Aplica el design system "Resonance Dark AI" completo. Elimina la pestaña **Free chat** del MVP (el endpoint `/api/chat` no se consume en la nueva UI).

## Por qué

El producto nuevo es una "sala de práctica de audio": el layout de tabs con chat genérico no soporta sesiones reanudables ni la metáfora karaoke. El shell es la base visual sobre la que viven 103/105/107/108/109 y evita rehacer el layout en cada feature.

## Requerimientos funcionales

- [x] `public/index.html` restructurado a las 3 zonas + dock; el `<body>` no ancla a tabs.
- [x] **Top bar:** brand "English AI Coach", pill de estado del motor de voz ("Speech Engine · READY"), botón *New Session* (atajo ⌘K) y *Settings* (overlay).
- [x] **Sidebar historial** (280px): agrupa sesiones Today / Yesterday / Previous 7 Days con score, nivel y anillo de progreso (ver 109 para el comportamiento; acá solo el contenedor + slots).
- [x] **Central stage:** contenedor máximo 840px con mask-gradient horizontal; aloja el canvas de config (103) o el de karaoke (105) vía router hash.
- [x] **Dock inferior flotante** (80px, inset 24px, blur 20px): orb push-to-talk (idle), waveform 32 barras, selector de tempo (0.75/1/1.25×), monitor de decibelios y estado de micrófono.
- [x] Router SPA hash: `#/` → config; `#/practice/<sessionId>` → práctica; `#/settings` → overlay; desconocido → `#/`. El router rehidrata la vista sin reload.
- [x] Settings abre como **overlay** desde el top bar y se cierra sin perder el estado de práctica activa.
- [x] Responsive: >1024px 3 zonas; 768–1023 sidebar→drawer; <768 una columna con dock anclado (safe-area insets).
- [x] Carga de fuentes: Space Grotesk, Inter, JetBrains Mono (Google Fonts) + Material Symbols Outlined.

## Requerimientos no funcionales

- CSS plano en `styles.css` con variables (`design-system.md`), sin librerías CSS. Cero dependencias npm nuevas acá.
- Contraste AA en texto sobre `--panel` (ver tabla de diseño).
- Componentes UI en módulos ES bajo `public/ui/` (nombres kebab-case), DOM construido con helper local (sin framework).
- Los módulos `speech/*` (voz) no se recolorean ni se reestructuran; solo se re-anchan sus eventos al dock.

## Decisiones de diseño / tecnología

- Canvas vectorial (waveform y anillos del orb) con Web Audio API, no librerías.
- El estado global del shell se comparte vía módulo singleton `public/ui/store.js` (estado de sesión activa, mic, tempo) — sin herramientas.
- Colores: verde `#10b981` acierto, cian `#06b6d4` audio activo, ámbar `#f59e0b`, carmesí `#ef4444` (tokens de `design-system.md`).
- "Free chat" eliminado: el fabric del `chat` de la vista old se borra del HTML/JS.

## Dependencias

- Ninguna nueva esperada (todo el frontend hereda de 001). Se apoya en el `store` y `app.js` actual.

## Criterios de aceptación

- [x] `npm test` y `npm run check` pasan.
- [x] Navegando `#/`, `#/practice/x` y Settings overlay no hay reload de página ni error de JS en consola. *(verificación visual en devtools recomendada en el PR)*
- [x] El layout 3-zonas+dock se renderiza correcto en ≥768px y colapsa bien en móvil (devtools).
- [x] El shell no consume `/api/chat` (verificable por red hasta `#/practice`).

## Fuera de alcance

- Contenido de las zonas (config/práctica/historial) → sus features (103/105/107/109).
- Estética de karaoke (105), waveform interactivo completo (105), configuración (108).
- Dark/light toggle (solo tema oscuro).

## Recursos

- `spec/design/design-system.md`, `spec/design/screens.md`, `spec/design/ui-flow.md`.
- Código a reemplazar: `public/index.html`, `public/styles.css`, `public/app.js`.
- Voz intacta: `public/speech/*`.