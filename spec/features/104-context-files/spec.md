# 104 · Ingesta de archivos de contexto

**Estado:** planificado 🔜 (ola 3)

## Contexto

- Caso de uso: CU1, paso "dropzone para soltar archivos" (`spec/use-cases/CU1.md`).
- Pantallas: `config-session.html` (dropzone); `screens.md` §1.
- **Excepción documentada a la regla "sin deps npm"** (`spec/constitution/tech-stack.md` § Límites duros): se autoriza `pdf-parse` y `mammoth` — las únicas dos. Todo lo demás se implementa con Node estándar.

## Qué hace

El dropzone del config acepta archivos **PDF, DOCX, TXT, MD**, los extrae a texto, los sanitiza y resume, y los incorpora como contexto de la sesión (`config.contextFiles`). El usuario no ve el texto completo; ve los chips con nombre/tamaño y el server prepara "trozos" inyectables en la Generación/Escena del LLM (dentro del límite de contexto).

## Por qué

CU1 pide dar más contexto a la conversación vía archivos (un job spec, una nota de arquitectura). PDF/DOCX no son texto plano y necesitan extracción real; autorizar dos librerías maduras evita reimplementar parsers.

## Requerimientos funcionales

- [ ] `POST /api/files/extract` acepta multipart; valida extensión y tamaño (máximo configurable, default 10 MB por archivo).
- [ ] TXT/MD → lectura directa UTF-8 (también acepta stricto `.txt`/`.md`);
- [ ] PDF → `pdf-parse` (texto por página); DOCX → `mammoth` (a text).
- [ ] Sanitización: se descartan binarios no decodificables, se recorta a N chars por archivo (default 40k), se eliminan secuencias de escape/nulos.
- [ ] Persistencia: el texto extraído se guarda en `data/tmp/context/<sessionId>/` (ignorada por git) o se re-extrae al crear sesión; el `config.contextFiles[]` guarda `{ name, size, kind, textRef }` (sin duplicar el contenido en el JSON de sesión).
- [ ] Resumen opcional del texto por LLM para caber en el contexto (si supera límite); detector de idioma suave.
- [ ] El contenido extraído se inyecta en el prompt de rol como "DOCUMENT CONTEXT" al generar la pregunta/respuesta (103/105), respetando instrucciones del usuario (dentro de prompts internos españoles? no: el texto del archivo se deja crudo, solo el wrapper en el prompt).
- [ ] No se sube nunca el archivo en sí a ningún proveedor externo: solo texto extraído.
- [ ] Errores amigables: `{ error }` con mensaje si el archivo no se puede parsear.

## Requerimientos no funcionales

- Los archivos NO se persisten (solo textRef y texto extraído en tmp). No se analizan audios (no es la función de este parser).
- Backend sin bloqueo: la extracción corre async; el modal de lanzamiento (103) puede ya estar en flight.

## Decisiones de diseño / tecnología

- Dependencias: `pdf-parse` (^1.x) y `mammoth` (^1.x) en `dependencies` de package.json. Avisar al usuario antes de `npm install` (regla de "no añadir deps sin avisar").
- Módulo `src/lib/extract.ts` con funciones puras `extractText(kind, buffer)`, `summarizeContext(files, llm)` y `trimToBudget`.
- Uso de construir "context budget": se le pasa al LLM el instruction del rol + fragments del doc, recortado a 16k chars.

## Dependencias

- 101 (UI), 102 (config.contextFiles), 103 (dropzone). La inyección en prompts la consumen 103/105.

## Criterios de aceptación

- [ ] Tests (`tests/extract.test.ts` existente se amplía): TXT/MD directos; PDF y DOCX con fixtures minimos de ejemplo; límite de tamaño; sanitización de nulos.
- [ ] Endpoint `POST /api/files/extract` funciona con presencia/ausencia del archivo.
- [ ] `npm test` y `npm run check` pasan.

## Fuera de alcance

- OCR de PDFs escaneados (documentar limitación). Archivos de audio. Parser de .ods/.xlsx. Generación de "resumen del doc" en la sesión (se deja como extensión).

## Recursos

- `tests/extract.test.ts` (existente), `src/lib/storage.ts`; verificar que `pdf-parse` sea compatible con Node 26 / type-stripping ESM (documentar fallback si falla el import).