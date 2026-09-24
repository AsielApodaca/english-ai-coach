# 108 · Settings en sub-tabs

**Estado:** implementado ✅ (ola 5)

## Contexto

- Pantallas: `settings.html`, `training.html`, `profile.html`, `hidden-model.html` (IDs `04dc70c267c24840b84a7389d0a7ad3a`, `65831b66f6eb45439ac9848dda13d397`, `1c146edbb6ec4fa2a2ef215d1fa368a1`, `8a75c21ad7a74d6ebe3c4f52cdbe13ea`); `screens.md` §3–6.
- Base existente: ajustes en localStorage `engcoach.*` (app.js actual) + `data/profile.json`.

## Qué hace

Rediseña la vista de Settings de una colección plana a un panel con **4 sub-tabs** coherentes con el layout del diseño, reutilizando y ampliando los ajustes actuales y añadiendo los controles de entrenamiento/pronunciación y perfil. La UI nueva aplica design-system (toggles switch, ghost buttons, chips) y persiste en `profile.json` (perfil) + `localStorage` (preferencias de dispositivos) con precedencia definida.

## Configuración modelada

### 1 · General & Audio (`settings.html`)
| Setting | Tipo | Persiste | Default |
| --- | --- | --- | --- |
| Dispositivo de entrada (micro) | select | localStorage `engcoach.mic` | system default |
| Volumen / prueba de sonido | slider + button | localStorage `engcoach.volume` | 100 |
| Mostrar anotación de pronunciación bajo la letra | toggle | localStorage `engcoach.showIpa` | true |
| Avanzar automáticamente al siguiente fragmento | toggle | localStorage `engcoach.autoAdvance` | false |
| Resaltado en vivo de errores (colores de 106) | toggle | localStorage `engcoach.liveHighlight` | true |

### 2 · Entrenamiento & Pronunciación (`training.html`)
| Setting | Tipo | Persiste | Default |
| --- | --- | --- | --- |
| Motor de reconocimiento (whisper model / Web Speech) | select | localStorage `engcoach.stt` | auto (`002`) |
| **Rigor** (Flexible >65 / Balanceado >82 / Estricto >93 F1) | segmented | profile `settings.rigor` | Balanceado |
| Sensibilidad a muletillas (Relajado/Moderado 2/frase/Sensible/Tolerancia Cero) | segmented | profile `settings.fillers` | Moderado |
| Ritmo de práctica (0.75/1/1.25×) | segmented | localStorage `engcoach.tempo` | 1× |
| Flujo continuo adaptativo (auto-adjust level/rigor) | toggle + thresholds | profile `settings.adaptive` | on, up 90/down 65 |

### 3 · Modelo IA (`hidden-model.html`, en términos del stack real)
| Setting | Tipo | Persiste | Default |
| --- | --- | --- | --- |
| Proveedor LLM primario (gemini/cloudflare/ollama) | select | profile `settings.provider` | auto (`001`) |
| Modelo whisper (tiny/base/small/medium/large) | select | localStorage `engcoach.whisperModel` | `002` |
| Motor TTS (piper/edge/speechSynthesis) + voz | select | localStorage `engcoach.voice` | auto (`007`) |
| Modo sin conexión (OFFLINE_MODE excluye proveedores web) | toggle | env + UI hint | off |
| Ruta de datos (`data/`) | readonly + hint | — | `data/` |

### 4 · Perfil & Datos (`profile.html`)
| Setting | Tipo | Persiste | Default |
| --- | --- | --- | --- |
| Persona del aprendiz (nombre, nivel objetivo, bio) | inputs | profile.json | derivado |
| Prompt del aprendiz (system persona editable) | textarea | profile.json | default |
| Focus fonéticos (chips `/θ/` `/v/-/b/` `/æ/`) | chips multi | profile `focusPhonemes` | [] |
| Export JSON (perfil + sesiones) | button → .json | — | — |
| Storage (breakdown de `data/` + espacio) | readonly | — | runtime |

## Requerimientos funcionales

- [x] Panel Settings como **overlay** (101) con sub-tabs a la izquierda; close no pierde la práctica activa.
- [x] Cada sub-tab edita su porción de estado; **precedencia:** `settingsSnapshot` de la sesión (102) > preferencias de localStorage > defaults de `profile.json > defaults` de código.
- [x] Los toggles de anotación/autoAdvance/liveHighlight afectan en vivo a la práctica karaoke (105/106) sin recargar.
- [x] Rigor/fillers/adaptive/prepTempo alimentan `config.settingsSnapshot` al **crear** sesión (103), no en runtime.
- [x] "Export JSON" descarga `data/profile.json` (y opcionalmente sesiones elegidas) como archivo.
- [x] Mapa de motor ("Speech Engine · READY" / "not installed") refleja whisper/piper/edge según instalados (data de `/api/health`).

## Requerimientos no funcionales

- Sin nuevas deps. UI accesible (focus visible, labels).
- Los keys de localStorage se documentan (tabla arriba) y se limpian al desinstalar (botón "Reset settings").

## Decisiones de diseño / tecnología

- Estado de settings en módulo `src/lib/settings.ts` (types + defaults + merge con precedencia, puro/testeable); el server lee profile para config; el front guarda devices en localStorage.
- Los 4 sub-tabs viven en `public/ui/settings/` como vistas parciales en ES modules (recargadas con el estado).
- Nombres de motores: los del stack real (whisper/piper/edge/proveedores), no los del diseño Stitch (que son no oficiales — `screens.md` §5 nota).

## Dependencias

- 101 (overlay + styling), 102 (persistencia snapshot), 103 (consumir config), 105/106 (reaccionar en vivo), 007/002 (health).

## Criterios de aceptación

- [x] Cambiar rigor/muletillas/adaptive → nueva sesión creada con `settingsSnapshot` correcto (test unitario merge).
- [x] Toggle de anotación de pronunciación encendido/apagado se refleja en el karaoke en vivo.
- [x] Export JSON descarga `profile.json`.
- [x] `npm test` y `npm run check` verdes.

## Fuera de alcance

- P2P/LAN sync, WebGPU, cifrado AES, "rebuild inference cache", modelos LLM fantasmas del diseño Stitch (no oficiales).

## Recursos

- `spec/design/screens.md` §3–6, `spec/design/design-system.md` (componentes), `public/app.js` (keys existentes), `src/lib/settings.ts` (nuevo), `src/lib/provider/` para status.