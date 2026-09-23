# 101 · Frontend shell — cockpit + design system

**Estado:** done ✅ (implementado en rama `feature/frontend-shell`)

## Contexto

- Casos de uso: transversal (base de CU1/CU2/CU3).
- Pantallas de diseño: todas (`spec/design/screens.md`).
- Referencia visual normativa: `spec/design/design-system.md` ("Resonance Dark AI").

## Qué hace

Reestructura el frontend de la app de la barra con tabs (Practice/Chat/Progress/Settings) a una **SPA tipo "cockpit de estudio"** (layout validado por PO contra los diseños de Stitch): **sidebar izquierda a altura completa** (280px) con brand "English AI Coach", botón *New Session*, historial y footer de usuario (pill "Speech Engine · READY", Guest + engranaje de settings); **top bar** solo a la derecha de la sidebar (breadcrumb + toggle) cuyo ancho se adapta cuando la sidebar se colapsa (drawer en tablet/móvil) y **central stage** (canvas dual config/práctica). Aplica el design system "Resonance Dark AI" completo. Elimina la pestaña **Free chat** del MVP (el endpoint `/api/chat` no se consume en la nueva UI). **El dock de audio (orb push-to-talk, waveform, tempo, VU meter) NO es parte de 101:** pertenece a 105 (CU2); hasta entonces la UI de práctica no muestra controles de grabación.

## Por qué

El producto nuevo es una "sala de práctica de audio": el layout de tabs con chat genérico no soporta sesiones reanudables ni la metáfora karaoke. El shell es la base visual sobre la que viven 103/105/107/108/109 y evita rehacer el layout en cada feature.

## Requerimientos funcionales

- [x] `public/index.html` restructurado al shell: sidebar full-height + columna de contenido (top bar + stage); el `<body>` no ancla a tabs.
- [x] **Sidebar** (280px, full-height, colapsable): brand "English AI Coach" + toggle de colapso; botón *New Session* (atajo ⌘K); historial agrupado Today / Yesterday / Previous 7 Days (ver 109 para el comportamiento; acá solo el contenedor + slots); footer con pill de estado del motor de voz ("Speech Engine · READY") arriba y fila de usuario (avatar, **Guest**, engranaje *Settings*) debajo.
- [x] **Top bar** (derecha de la sidebar, 48px, frosted): toggle de apertura de la sidebar (self-hide en desktop con sidebar visible) + breadcrumb "Studio / Config|Practice". Su ancho se adapta al estado de la sidebar (desktop collapsed → ocupa todo el ancho).
- [x] **Central stage:** contenedor máximo 840px con mask-gradient horizontal; aloja el canvas de config (103) o el de karaoke (105) vía router hash.
- [x] Router SPA hash: `#/` → config; `#/practice/<sessionId>` → práctica; `#/settings` → overlay; desconocido → `#/`. El router rehidrata la vista sin reload y actualiza el breadcrumb.
- [x] Settings abre como **overlay** desde el engranaje de la sidebar y se cierra sin perder el estado de práctica activa.
- [x] Responsive: >1024px sidebar full-height colapsable (top bar la sigue); 768–1023 sidebar→drawer off-canvas con backdrop; <768 una columna (kelto de sesión compacto). Sin UI de audio hasta 105.
- [x] Carga de fuentes: Space Grotesk, Inter, JetBrains Mono (Google Fonts) + Material Symbols Outlined.

## Requerimientos no funcionales

- CSS plano en `styles.css` con variables (`design-system.md`), sin librerías CSS. Cero dependencias npm nuevas acá.
- Contraste AA en texto sobre `--panel` (ver tabla de diseño).
- Componentes UI en módulos ES bajo `public/ui/` (nombres kebab-case), DOM construido con helper local (sin framework).
- Los módulos `speech/*` (voz) no se recolorean ni se reestructuran; se re-anchan en 105 cuando llegue el dock.

## Decisiones de diseño / tecnología

- Layout fijo espejo de Stitch: sidebar `fixed` full-height (`--sidebar-w: 280px`), top bar `fixed left: var(--sidebar-w)` que colapsa a `left: 0` cuando la sidebar está oculta; stage con `margin-left` equivalente.
- Sin canvas en 101: waveform/orb serán canvas vectorial + Web Audio API en 105, no librerías.
- El estado global del shell se comparte vía módulo singleton `public/ui/store.js` (estado de sesión activa, speechReady, sidebarOpen) — sin herramientas.
- Colores: verde `#10b981` acierto, cian `#06b6d4` audio activo, ámbar `#f59e0b`, carmesí `#ef4444` (tokens de `design-system.md`).
- "Free chat" eliminado: el fabric del `chat` de la vista old se borra del HTML/JS.

## Dependencias

- Ninguna nueva esperada (todo el frontend hereda de 001). Se apoya en el `store` y `app.js` actual.

## Criterios de aceptación

- [x] `npm test` y `npm run check` pasan.
- [x] Navegando `#/`, `#/practice/x` y Settings overlay no hay reload de página ni error de JS en consola. *(verificación visual en devtools recomendada en el PR)*
- [x] El shell (sidebar full-height + top bar a la derecha) se renderiza correcto en ≥768px y colapsa bien en móvil (devtools).
- [x] El shell no consume `/api/chat` (verificable por red hasta `#/practice`).

## Fuera de alcance

- Contenido de las zonas (config/práctica/historial) → sus features (103/105/107/109).
- **Dock de audio (orb push-to-talk, waveform, tempo, VU meter)** → 105 (CU2).
- Estética de karaoke (105), configuración (108).
- Dark/light toggle (solo tema oscuro).

## Recursos

- `spec/design/design-system.md`, `spec/design/screens.md`, `spec/design/ui-flow.md`.
- Código a reemplazar: `public/index.html`, `public/styles.css`, `public/app.js`.
- Voz intacta: `public/speech/*`.