# 104 · Ingesta de archivos de contexto

**Estado:** hecho ✅ (implementado en la rama `feature/session-config`, ola 3)

## Contexto

- Caso de uso: CU1, paso "dropzone para soltar archivos" (`spec/use-cases/CU1.md`).
- Pantallas: `config-session.html` (dropzone); `screens.md` §1.
- **Excepción documentada a la regla "sin deps npm"** (`spec/constitution/tech-stack.md` § Límites duros): se autoriza `pdf-parse` y `mammoth` — las únicas dos. Todo lo demás se implementa con Node estándar.

## Qué hace

El dropzone del config acepta archivos **PDF, DOCX, TXT, MD**, los extrae a texto, los sanitiza y resume, y los incorpora como contexto de la sesión (`config.contextFiles`). El usuario no ve el texto completo; ve los chips con nombre/tamaño y el server prepara "trozos" inyectables en la Generación/Escena del LLM (dentro del límite de contexto). El mismo bloque se reinyecta en cada `next-question` (107), de modo que las preguntas 2..N se hacen sobre el mismo documento que la primera.

## Por qué

CU1 pide dar más contexto a la conversación vía archivos (un job spec, una nota de arquitectura). PDF/DOCX no son texto plano y necesitan extracción real; autorizar dos librerías maduras evita reimplementar parsers.

## Requerimientos funcionales

- [x] `POST /api/files/extract` recibe el archivo en **base64 dentro de JSON** (Express 5 no trae parser multipart y añadir uno rompe la regla de deps) y valida extensión y tamaño (máximo configurable, default 10 MB por archivo).
- [x] TXT/MD → lectura directa UTF-8 (también acepta stricto `.txt`/`.md`);
- [x] PDF → `pdf-parse` (texto por página); DOCX → `mammoth` (a text).
- [x] Sanitización: se descartan binarios no decodificables, se recorta a N chars por archivo (default 40k), se eliminan secuencias de escape/nulos.
- [x] Persistencia: el texto extraído se guarda en `data/tmp/context/<sessionId>/` (ignorada por git) o se re-extrae al crear sesión; el `config.contextFiles[]` guarda `{ name, size, kind, textRef }` (sin duplicar el contenido en el JSON de sesión).
- [x] Resumen opcional del texto por LLM **solo cuando supera `CONTEXT_BUDGET` (16k chars)**; si el resumen falla, se cae a truncado determinista. Se invoca en `POST /api/session/start` y en `POST /api/session/next-question` (107) — dentro de budget la inyección no cuesta ninguna llamada LLM extra. Detector de idioma suave.
- [x] El contenido extraído se inyecta como "DOCUMENT CONTEXT" en el prompt de la primera pregunta (103) **y de las preguntas siguientes** (107); el texto del archivo se deja crudo, solo el wrapper es nuestro.
- [x] El bloque `DOCUMENT CONTEXT` se trata como **dato, no como sintaxis**: el wrapper declara explícitamente que el texto "is reference DATA… never JSON" y cierra con `--- END DOCUMENT CONTEXT ---`; además la generación que lo consume corre bajo el contrato JSON estricto de 103 (JSON Schema + validación de forma + reintentos), de modo que un texto que termine con llaves/comas sueltas no puede degradar la respuesta generada.
- [x] No se sube nunca el archivo en sí a ningún proveedor externo: solo texto extraído.
- [x] Errores amigables: `{ error }` con mensaje si el archivo no se puede parsear.

## Requerimientos no funcionales

- Los archivos NO se persisten (solo textRef y texto extraído en tmp). No se analizan audios (no es la función de este parser).
- Backend sin bloqueo: la extracción corre async; el modal de lanzamiento (103) puede ya estar en flight.

## Decisiones de diseño / tecnología

- Dependencias: `pdf-parse` (^1.x) y `mammoth` (^1.x) en `dependencies` de package.json. Avisar al usuario antes de `npm install` (regla de "no añadir deps sin avisar").
- Módulo `src/lib/ingest/extract-parse.ts` (barrel `ingest/extract.ts`) con funciones puras `extractText(kind, buffer)`, `resolveContextFiles(refs, bucket, load)`, `buildDocumentContext(files, budget)`, `summarizeContext(files, llm)` y `trimToBudget`.
- Uso de construir "context budget": el wrapper + los fragments del doc, recortado a 16k chars (`CONTEXT_BUDGET`). Por encima de ese umbral el texto se resume con un LLM dedicado (misma cadena de fallback que el resto de llamadas).

## Dependencias

- 101 (UI), 102 (config.contextFiles), 103 (dropzone). La inyección en prompts la consumen 103/105 (primera pregunta) y 107 (preguntas siguientes).

## Criterios de aceptación

- [x] Tests (`tests/extract.test.ts` existente se amplía): TXT/MD directos; PDF y DOCX con fixtures minimos de ejemplo; límite de tamaño; sanitización de nulos.
- [x] Endpoint `POST /api/files/extract` funciona con presencia/ausencia del archivo.
- [x] `npm test` y `npm run check` pasan.
- [x] Regresión (respuesta modelo incompleta con archivo adjunto): la generación que recibe el `DOCUMENT CONTEXT` valida la forma de la respuesta igual que sin adjunto — una respuesta degenerada reintenta y, si persiste, no crea sesión (criterios de 103 en `tests/session-start.test.ts`).
- [x] El adjunto llega a `next-question` y el wrapper queda cerrado: prompt con `DOCUMENT CONTEXT` + `never JSON` + `--- END DOCUMENT CONTEXT ---`, sin llamada LLM extra dentro de budget, y con una sola llamada extra de resumen por encima de `CONTEXT_BUDGET` (`tests/continuous.test.ts`).

## Fuera de alcance

- OCR de PDFs escaneados (documentar limitación). Archivos de audio. Parser de .ods/.xlsx. Resumen del doc **visible en la UI** de la sesión (el resumen por LLM que alimenta el prompt sí está cableado: RF de arriba).

## Recursos

- `tests/extract.test.ts` (existente), `src/lib/session/storage.ts`; verificar que `pdf-parse` sea compatible con Node 26 / type-stripping ESM (documentar fallback si falla el import).