# 109 · Historial y reanudación de sesiones (CU3)

**Estado:** planificado 🔜 (ola 6)

## Contexto

- Caso de uso: **CU3** (`spec/use-cases/CU3.md`).
- Pantallas: sidebar de Config y Práctica (IDs `a75ca4c…` y `ffb4dd13…`); `screens.md` §2 (sidebar).
- Base: `src/lib/storage.ts` (guarda por sesión), modelos 102 (status/groupByRecency).

## Qué hace

Implementa el **historial de sesiones** en el sidebar del cockpit y el ciclo de **reanudación**: al entrar al sistema se muestra el home (config — CU3), y el sidebar lista las sesiones agrupadas (Today / Yesterday / Previous 7 Days) con score, nivel y anillo de progreso. Una sesión **activa** (pendiente de concluir) se puede **reanudar** en el punto exacto donde quedó (misma pregunta, mismo fragmento). Las sesiones completadas se abren en modo lectura (review) sin volver a grabarlas. La creación de una sesión nueva está gobernada por la regla CU3: **solo si se llega a iniciar una práctica**.

## Por qué

CU3 pide "historial de sesiones con progreso separado" y reanudación de aprendizaje. Sin esto las sesiones son archivos perdidos; con esto el sidebar se convierte en el mapa del progreso del aprendiz.

## Requerimientos funcionales

- [ ] **Listado agrupado:** `GET /api/sessions?group=recency` → `{ groups: [{ label: "Today"|"Yesterday"|"Previous 7 Days", items: SessionSummary[] }] }`; `SessionSummary = { id, title, level, provider, status, updatedAt, score?, progress: { answered, total, pct } }`.
- [ ] **Reducir carga:** el listado no incluye el `topicPrompt` completo, solo `title` derivado (102).
- [ ] **Sidebar UI (101/109):** cada item con anillo de progreso (score de pronunciación → color carmesí→esmeralda), badge de nivel, y badge **"ACTIVA (Q{n})"** para la sesión en curso; botón *New Session* en cabecera del sidebar; estado vacío para primer uso ("No sessions yet").
- [ ] **Reanudar activa:** click → `#/practice/<id>` → la máquina de estados de 105 retoma en el último checkpoint (`status=active`, pregunta/fragmento salvados). La práctica no reinicia la pregunta actual.
- [ ] **Abrir completada (review):** modo lector: muestra pregunta/respuesta, intentos con colores (words[] de 106 guardados), feedback y eval; sin grabación; botón "Practicar de nuevo" → nueva sesión con misma config (reusa `config` para 103 prefill).
- [ ] **Cierre/abandono:** "Finalizar Sesión" → completed; navegar/volver a config (breadcrumb) → deja `active` y guarda. Al entrar de nuevo, el sidebar la muestra y permite reanudar.
- [ ] **Eliminar / exportar:** acción por sesión (delete `data/sessions/<id>.json`) y export de una sesión (JSON) — este último de bajo perfil en el dado de perfil (108).
- [ ] CU3: el historial **no** lista sesiones sin iniciar; si el usuario nunca crea una, el sidebar está vacío.

## Requerimientos no funcionales

- Sidebar colapsable en tablet, drawer en móvil (101).
- `listSessions` bajo: lectura ligera en `data/sessions` (solo frontmatter de cada JSON), sin cargar contenido hasta abrir.
- No se borra una sesión activa sin confirmación.

## Decisiones de diseño / tecnología

- `groupByRecency(sessions)` en `storage.ts` (ya en 102): bucket por `updatedAt` para Hoy/Ayer/7 días/más antiguo.
- `title` derivado por LLM en creación (102) con fallback de primeras palabras.
- El botón "hacer otra práctica" de 105/107 navega a `#/` (config); la anterior queda `completed` o `active` si se canceló.

## Dependencias

- 101 (sidebar), 102 (schema + listado), 105/107 (checkpoints y states para reanudar), 106 (words[] para review), 108 (export) — jefe transversal que cierra CU3.

## Criterios de aceptación

- [ ] Tras terminar una sesión completa se ve en "Today" con score; tras 1 día en "Yesterday" o "Previous 7" según `updatedAt`.
- [ ] Interrumpir una sesión en Q3-Fragmento2 y reentrar la reanuda en ese punto sin reset.
- [ ] Abrir una completada muestra colores/feedback (review); "Practicar de nuevo" prefill de config.
- [ ] Test storage groupByRecency y listSessions (no carga cuerpos).
- [ ] `npm test` y `npm run check` verdes.

## Fuera de alcance

- Cifrado de sesiones (no necesario: local, no subir). Estadísticas agregadas hasta 108/004. P2P.

## Recursos

- `spec/use-cases/CU3.md`, `spec/design/screens.md` §2/§6, `spec/design/design-system.md` (componente 6 sidebar), `src/lib/storage.ts`, `src/server.ts`.