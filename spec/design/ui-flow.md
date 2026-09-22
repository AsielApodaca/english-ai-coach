# Map de UI — casos de uso ↔ pantallas ↔ features

Este documento es el "mapa de navegación" del producto v2. Conecta los casos de uso documentados (`/spec/use-cases`), las pantallas de diseño (`/spec/design/screens.md`) y las features del roadmap.

## Flujo de navegación global

```
                    ┌─────────────────────────────┐
                    │  ENTRADA (home)             │
                    │  → Config (CU1 / screen 1)  │
                    └──────────────┬──────────────┘
                  iniciar práctica │ (botón habilita al llenar topic+level)
                                   ▼
                    ┌─────────────────────────────┐
                    │  Modal "Iniciando Sala de   │  → Cancelar → vuelve config
                    │  Audio" (DSP→Aligner→Topic)│  → Entrar al Estudio
                    └──────────────┬──────────────┘
                                   ▼
                    ┌─────────────────────────────┐   Q_n preguntas (Q1→Q∞)
                    │  PRÁCTICA KARAOKE (CU2 /     │ ◄── button "Siguiente Pregunta"
                    │  screen 2)                   │   flujo continuo (107)
                    │  loop: pregunta→modelo→      │
                    │  fragments (repeat)→colores→ │
                    │  feedback→full answer        │
                    └───────┬─────────────────────┘
                            │ Finalizar Sesión   │ retroceder (arrow) → CU1
                            ▼                     ▼ config (nueva práctica)
        Persistent: sidebar history (CU3/screen 2)  → "hacer otra práctica"
                            │
                            └─► resume (sesión activa) → vuelve a PRÁCTICA KARAOKE
```

## Matriz de mapeo

| CU | Pantalla(s) (IDs Stitch) | Feature(s) principal | Soporte |
| --- | --- | --- | --- |
| CU1 Configurar | `a75ca4c…`, `26c911…` | `103-session-config-cu1` | `101` (shell/layout), `102` (config snapshot), `104` (dropzone) |
| CU2 Conversar | `ffb4dd13…`, `1c6af7…` | `105-karaoke-practice-cu2` | `106` (word timestamps), `101`, `107` (continuo/adaptativo) |
| CU3 Crear sesión | sidebar de `a75ca4c…` y `ffb4dd13…` | `109-session-history-resume` | `102` (schema + status), `101` (sidebar) |
| — (Transversal) | `04dc70c2…`, `65831b66…`, `8a75c21a…`, `1c146edb…` (Settings) | `108-settings` | `101` (sub-tabs), `102` (persistencia) |

## Reglas de transición (SPA hash-router)

1. `/` (home) → siempre Config (CU3: "el usuario entra al sistema → muestra CU1"). Si existe una sesión active reciente, la UI lo insinúa en el sidebar (botón "Reanudar") **sin** forzar un modal.
2. Config → práctica: botón start → modal de transición → `/practice/<sessionId>`.
3. Dentro de práctica:
   - "Siguiente Pregunta" → genera Q_n+1 y reinicia el loop CU2.
   - "Finalizar Sesión" → marca sesión `completed`, guarda, muestra pantalla de cierre con "Hacer otra práctica" (→ `/`) — per CU2 paso 20.
   - "Retroceder" (breadcrumb) → guarda estado `active` parcial y vuelve a `/` (resumible — CU3).
4. Settings se abre como overlay desde top-bar en cualquier vista; no reemplaza el historial de navegación de la práctica.
5. Sidebar interactúa en cualquier vista: click en sesión pasada del historial → abre resize "archived session" (o, si `active`, botón "Reanudar").

## Estados de sesión y su expresión visual

| Status | Significado | UI |
| --- | --- | --- |
| `active` | Config iniciada, práctica incompleta o en pausa | Badge "ACTIVA (Q1)" + botón reanudar en sidebar |
| `completed` | Práctica finalizada (feedback de cierre emitido) | Anillo de progreso con score final |
| (no creada) | Nunca se llegó a iniciar | No existe en historial (CU3: no se guarda nada) |

## Dependencias transversales (orden de implementación sugerido)

1. `101` (shell) → base visual de todo.
2. `102` (modelo de datos) → base de persistencia de todo.
3. `106` (timestamps whisper) + `002` (audio founder) → base de coloreado.
4. `103` + `104` → entrada (CU1).
5. `105` → práctica (CU2) construye sobre 101,102,106.
6. `107` → flujo continuo adaptativo sobre 105.
7. `108` → settings transversal (paralela).
8. `109` → historial/resume (CU3) sobre 102 + 105/107.
9. `004/005/006` (backlog) → refinan prononcación, vocabulario y offline sobre el modelo v2.