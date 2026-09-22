# CU3 · Crear nueva sesión de aprendizaje

> Código fuente: `english-ai-coach-documentation/CU3_Crear-nueva-sesion-de-aprendizaje.md` (documento oficial del producto). Este spec/use-case es una transcripción + interpretación técnica para desarrollo.

## Texto del caso de uso (original)

**Actor:** Usuario.

**Objetivo:** Que el usuario cree una sesión de aprendizaje, guardando el progreso de una sesión separada de las demás sesiones, con la finalidad de tener un historial de sesiones con progreso separado y distintos temas de conversación.

**Precondiciones:**
- Tener una cuenta de usuario iniciada para guardar sesiones de conversación.

**Disparador:** El usuario ingresa al sistema.

**Flujo principal:**
1. El usuario entra al sistema.
2. El sistema muestra el CU1_Configurar-conversacion-con-ai-coach.
3. El usuario inicia una conversación.
4. El sistema guarda la sesión en el historial de sesiones.

**Flujos alternativos / errores:**
- El usuario no completa el CU1_Configurar-conversacion-con-ai-coach → no se crea sesión y no se guarda nada en el historial.

**Postcondiciones:** Queda la sesión guardada en el historial de sesiones.

**Resultado:** Cuando el usuario haya configurado e iniciado una conversación, se guardará como sesión en un historial de sesiones donde el usuario podrá acceder a otras sesiones creadas y continuar el aprendizaje de esas sesiones.

## Interpretación técnica (para desarrollo)

**Sobre la "cuenta de usuario":** la app es local y de usuario único (misión: "Usuario único, personal, en macOS"). No existe login. La "cuenta" se interpreta como el **perfil local** `data/profile.json`; el guardado de sesiones siempre está disponible y no requiere autenticación. Se documenta esta interpretación para no inventar un sistema de login.

**Flujo y regla de creación:**
1. El sistema entra en la vista de configuración (CU1) — es el home del producto. **La entrada al sistema SIEMPRE muestra la config.**
2. El usuario completa la config y presiona "Iniciar práctica" → se crea la sesión con `status: "active"` (feature `102-session-model-v2`).
3. La sesión se persiste en `data/sessions/<id>.json` en el momento de iniciarse (o en el primer punto de progreso), no solo al terminar.
4. Si el usuario **no llega a iniciar** una práctica, no se crea nada (regla del flujo alternativo).

**Historial con progreso separado:** cada sesión guarda de forma independiente config + progreso parcial + resultados. El histórico se muestra en el sidebar (agrupado Hoy / Ayer / Últimos 7 días) y permite **reanudar** una sesión activa (decisión del equipo: sesión continua reanudable — feature `109-session-history-resume`).

**Pantallas de diseño relacionadas:**
- Sidebar de todas las pantallas de Stitch (columna izquierda con historial de sesiones agrupado por recencia, con score y anillo de progreso).
- `ffb4dd13e7c44d5092d7b3b4323e2378` (práctica muestra "Junior SWE First Interview" con badge "ACTIVA (Q1)").

**Features que implementan este CU:** `102-session-model-v2` (schema + persistencia + agrupación), `109-session-history-resume` (sidebar, agrupación, resume), `101-frontend-shell` (layout sidebar), `105/107` (generan el progreso que se guarda).