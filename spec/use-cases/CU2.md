# CU2 · Conversar con ai coach

> Código fuente: `english-ai-coach-documentation/CU2_Conversar-con-ai-coach.md` (documento oficial del producto). Este spec/use-case es una transcripción + interpretación técnica para desarrollo.

## Texto del caso de uso (original)

**Actor:** Usuario.

**Objetivo:** Que el usuario practique entrevistas técnicas u otros tópicos, a través de una conversación por audio, fluida y de naturaleza humana con el ai coach, con la finalidad de mejorar el inglés del usuario.

**Precondiciones:**
- Tópico seleccionado (ej. Interview).
- Nivel de inglés seleccionado (ej. B2).

**Disparador:** El usuario presiona el botón "Iniciar práctica".

**Flujo principal:**
1. El ai coach habla, introduce la conversación y comienza dando contexto acerca del tópico seleccionado; explica cómo será la dinámica dentro de la conversación. El ai coach comenzará la práctica diciendo una pregunta típica de la vida real, dependiendo del contexto y del tópico (ej. tópico "Interview", pregunta: "What is your biggest weakness?").
2. La interfaz muestra la pregunta principal en la pantalla.
3. Posterior a que el ai coach diga la pregunta, el ai coach generará una respuesta a esta pregunta (siguiendo el ejemplo de "interview", generará una respuesta fuerte y completa a la pregunta de entrevista).
4. La respuesta generada por el ai coach se muestra en la interfaz en letras grandes como si fuera la letra de una canción en Spotify.
5. El ai coach leerá la respuesta completa.
6. El ai coach explica al usuario que ponga atención; el coach explica que leerá la respuesta por fragmentos y que el usuario debe escuchar cómo se pronuncia cada fragmento y, al terminar, repetirlo.
7. La interfaz resalta la letra del fragmento.
8. El ai coach dice el primer fragmento.
9. El usuario repite el fragmento.
10. El sistema escucha al usuario y en vivo va resaltando en diferentes colores el fragmento repetido por el usuario (palabra que concuerda → verde si fue bien dicha; amarillo si la pronunciación no fue del todo correcta o puede mejorar; rojo si la palabra se pronunció de forma incorrecta o no se mencionó).
11. El ai coach da feedback.
12. El ai coach dice el siguiente fragmento de la respuesta.
13. Se repite desde el paso del usuario hasta que repite el último fragmento de la respuesta.
14. El coach instruye al usuario a leer la respuesta entera.
15. El sistema quita los colores de la respuesta y resalta toda la respuesta.
16. El usuario lee toda la respuesta.
17. El sistema marca los colores de cada palabra en vivo conforme el usuario habla.
18. El coach evalúa y da feedback.
19. Se termina la práctica y se cierra la conversación.
20. El sistema oculta la conversación y muestra un botón de "hacer otra práctica".

**Flujos alternativos / errores:**
- Si en el paso del usuario no repite correctamente todo el fragmento, el ai coach, tras dar feedback, pedirá que lo intente nuevamente: relee el fragmento y el usuario reintenta.
- Ídem para la lectura de la respuesta entera.

**Postcondiciones:** Se muestra el botón de hacer nueva práctica.

**Resultado:** Se realizó una conversación de audio donde se practicó un escenario en inglés repitiendo tras escuchar.

## Interpretación técnica (para desarrollo)

El CU2 es el corazón del producto. Se descompone en fases estrictas de una pregunta de sesión:

| Fase | Paso CU | Responsabilidad |
| --- | --- | --- |
| **Intro** | 1 | El coach habla (TTS) una introducción con contexto del tópico + explicación de la dinámica. Texto generado por LLM y reproducido con voz humana (`007-natural-tts`). |
| **Pregunta** | 1–2 | LLM genera la pregunta típica del tópico; se muestra en pantalla y se lee con TTS. |
| **Respuesta modelo** | 3–5 | LLM genera la respuesta fuerte/completa a la pregunta; se muestra **en formato karaoke estilo Spotify** (tipografía grande, línea de fragmentos) y el coach la lee completa. |
| **Explicación** | 6–7 | Coach explica el método fragmento-a-fragmento; la interfaz resalta el fragmento activo. |
| **Loop de fragmentos** | 8–13 | Por cada fragmento: coach lo dice → usuario lo repite → sistema colorea palabras (verde/ámbar/rojo) → coach da feedback → avanza o pide reintento (si no pasa el umbral). |
| **Respuesta completa** | 14–17 | Se quita el coloreado por fragmento, se resalta la respuesta entera; el usuario la lee completa; se marcan colores en vivo al hablar. |
| **Cierre** | 18–20 | Coach evalua y da feedback; se cierra la conversación, se oculta y se muestra "hacer otra práctica" (vuelve a CU1). |

**Semántica del color de palabra (núcleo de la feature 105/106):**
- **Verde** — la palabra fue reconocida y se alineó correctamente con la palabra objetivo (bien dicha).
- **Ámbar** — la palabra fue dicha pero con imprecisión (sin repetición de la 004, el ámbar se resuelve por: palabra alineada dentro del fragmento pero con timestamps solapados/conflictivos, o keywords señaladas por el evaluador LLM con issues de pronunciación en esa palabra; cuando la feature `004-phonetic-evaluation` exista, el ámbar se determina por divergencia fonética real).
- **Rojo** — la palabra objetivo no se dijo (missing) o se dijo una palabra no esperada (extra/incorrecta).

> Decisión registrada: el coloreado **en vivo palabra a palabra** exacto no es posible con whisper-cli (batch). MVP: marca post-grabación con animación sincronizada de timestamps (feature `106-word-timestamps`). El camino futuro a coloreado en tiempo real queda documentado como extensión en `106`.

**Reintento / umbral:** Un fragmento pasa (verde→avanzar) cuando `score >= passThreshold` (umbral configurable en settings `108`, default heredado de `001` = 70). Si no pasa, el coach da feedback por voz y pide reintento (loop interno). El ciclo de "respuesta entera" replica el mismo criterio.

**Cierre / nueva práctica:** Al terminar, el sistema guarda la sesión (CU3 / `109`) y muestra el botón "hacer otra práctica" que regresa al config (CU1).

**Pantallas de diseño relacionadas:**
- `ffb4dd13e7c44d5092d7b3b4323e2378` — "Práctica en Vivo - Formato Letras Spotify (Flujo Continuo de Preguntas)"
- `1c6af75e5fac4d13bfe531f7dc945f2f` — "Práctica en Vivo - Formato Letras Spotify (Minimalist)"

**Features que implementan este CU:** `105-karaoke-practice-cu2` (orquestación de fases + UI), `106-word-timestamps` (coloreado), `107-continuous-session` (extensión Q1→Q∞, fuera del CU base pero en el diseño), `103-session-config-cu1` (disparador), `102/109` (persistencia e historial).