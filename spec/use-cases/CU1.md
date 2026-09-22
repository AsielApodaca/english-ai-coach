# CU1 · Configurar conversación con AI coach

> Código fuente: `english-ai-coach-documentation/CU1_Configurar-conversacion-con-ai-coach.md` (documento oficial del producto). Este spec/use-case es una transcripción + interpretación técnica para desarrollo.

## Texto del caso de uso (original)

**Actor:** Usuario.

**Objetivo:** Configurar el tópico y nivel de inglés de la conversación con el ai coach, a través de un formulario de opciones de configuración, con la finalidad de preparar al ai coach para generar una conversación.

**Precondiciones:**
- No debe haber una conversación activa o se debe haber finalizado.

**Disparador:** — (implícito: el usuario entra al sistema)

**Flujo principal:**
- La interfaz muestra:
  - Un textarea para describir el tema de la conversación e instruir al ai coach sobre qué discutir.
  - Un dropdown para seleccionar el nivel de inglés (A1 → C2), con un nivel predefinido.
  - Un textarea para describir el tópico.
  - Un dropzone para soltar archivos.
  - Un botón deshabilitado para iniciar conversación.
- El usuario escribe el tema de la conversación que se practicará con el ai coach.
- El sistema habilita el botón para iniciar conversación (el requisito para habilitarse es haber escrito algo en el textarea y tener un nivel de inglés seleccionado, el cual ya tiene un nivel seleccionado por defecto).
- El usuario selecciona un nivel de inglés.
- El usuario opcionalmente arrastra un archivo al dropzone para añadir más contexto a la conversación.
- El usuario presiona el botón para iniciar la conversación con la configuración proporcionada.

**Flujos alternativos / errores:** —

**Postcondiciones:** Inicia el caso de uso CU2_Conversar-con-ai-coach.

**Resultado:** El usuario configuró la conversación, proporcionando al ai coach una descripción acerca del tema a conversar, un nivel de inglés y opcionalmente archivos para dar mayor contexto, lo que permitió generar una conversación de acuerdo a los requerimientos del usuario.

## Interpretación técnica (para desarrollo)

Campos del flujo y su equivalencia en el sistema:

| Elemento del CU | Definición producto | Equivalencia técnica |
| --- | --- | --- |
| Textarea "tema de la conversación e instruir al ai coach" | Descripción libre que instruye el rol del coach y el tópico (ver diseño: "Instrucción de Rol para el AI Coach") | `session.config.topicPrompt` |
| Textarea "describir el tópico" | El CU menciona dos textareas; el diseño las unifica en UNA instrucción de rol (prompt). Se documenta como **un solo textarea** (`topicPrompt`). | `session.config.topicPrompt` |
| Dropdown de nivel A1→C2 con predefinido | Nivel objetivo de la conversación | `session.config.level` — **el sistema debe ampliar el enum de niveles de B1/B2/C1 a A1–C2** |
| Dropzone de archivos | Contexto extra opcional | Feature `104-context-files` (`session.config.contextFiles[]`) |
| Botón "Iniciar práctica" deshabilitado → habilitado | Se habilita solo cuando `topicPrompt` no vacío y `level` seleccionado | Validación client-side |
| Precondición "no debe haber conversación activa" | Iniciar sesión nueva desde el estado inactivo; si hay sesión activa, primero ofrecer reanudar (ver CU3 y `109`) | `session.status` |

**Niveles de ingles:** A1, A2, B1, B2, C1, C2 (CEFR completo). El nivel predefinido sale del perfil del aprendiz (`data/profile.json.level`) con fallback `B2` (el diseño usa B2 como default de UI).

**Salto a CU2:** La postcondición dispara CU2 (`105-karaoke-practice-cu2`). El flujo intermedio de "launch" (modal "Iniciando Sala de Audio / Conectando") es un paso de transición visual del diseño y se modela en `103-session-config-cu1`.

**Pantallas de diseño relacionadas:**
- `a75ca4c11b78459b932420a2f72c6fe7` — "Configurar Sesión con AI Coach - Minimalist"
- `26c911872fcf4fa7a781cb786229ac17` — "Configurar Sesión con AI Coach" (variante)

**Features que implementan este CU:** `103-session-config-cu1` (orquestación + UI), `104-context-files` (dropzone), `102-session-model-v2` (config snapshot), `108-settings` (ajustes que alimentan la config).