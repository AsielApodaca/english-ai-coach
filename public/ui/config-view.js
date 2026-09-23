/**
 * Session configuration view (feature 103 / CU1) — the product home.
 *
 * The user describes the coach role (topicPrompt), picks a CEFR level, may
 * attach context files (feature 104 dropzone), chooses an accent + phonetic
 * focus, verifies the microphone, and starts a practice. "Iniciar práctica"
 * stays disabled until topicPrompt is non-empty and the level is valid;
 * pressing it opens the "Iniciando Sala de Audio" launch modal and only
 * "Entrar al Estudio" creates the session via POST /api/session/start
 * (CU3: no session is created before that).
 *
 * The config draft lives in module state only (no disk autosave — feature 109
 * owns the data/tmp draft), so leaving the view and returning within the same
 * page load restores the form.
 */

import { h, escapeHtml } from "./dom.js";
import { WaveRecorder } from "../speech/recorder-wave.js";

const TOPIC_MAX = 6000;
const DEFAULT_PROMPT =
  "Simula ser un Engineering Manager senior de Google realizando una entrevista técnica. Mi rol es el candidato. Hazme preguntas técnicas desafiantes…";

const LEVELS = [
  { value: "A1", label: "A1 Starter" },
  { value: "A2", label: "A2 Elementary" },
  { value: "B1", label: "B1 Intermediate" },
  { value: "B2", label: "B2 Working" },
  { value: "C1", label: "C1 Advanced" },
  { value: "C2", label: "C2 Mastery" },
];

const ACCENTS = [
  "General American (US)",
  "Received Pronunciation (UK)",
  "Australian",
  "Canadian",
  "Indian English",
  "Neutral",
];

const TEMPLATES = [
  {
    name: "Mock Tech Interview",
    level: "B2",
    prompt:
      "Simula ser un Engineering Manager senior de Google realizando una entrevista técnica. Mi rol es el candidato. Hazme preguntas técnicas desafiantes sobre algoritmos, sistemas distribuidos y diseño de APIs, y evalúa mis respuestas como lo haría un entrevistador real.",
  },
  {
    name: "System Design Defense",
    level: "C1",
    prompt:
      "Actúa como un Staff Engineer defendiendo mi diseño de sistema. Preséntame un escenario de diseño a gran escala y hazme preguntas de seguimiento sobre escalabilidad, consistencia y trade-offs. Corrige mis decisiones cuando sea necesario.",
  },
  {
    name: "Client Demo Pitch",
    level: "B2",
    prompt:
      "Simula ser un cliente potencial en una demo de producto. Mi rol es el Account Executive. Hazme preguntas sobre el producto, objeciones realistas y pídeme que demuestre el valor de la solución en inglés técnico.",
  },
  {
    name: "Behavioral Leadership",
    level: "B2",
    prompt:
      "Simula ser un interviewer de behavioral (leadership) en una empresa tech. Hazme preguntas estilo STAR sobre liderazgo, conflictos y toma de decisiones, y dame feedback sobre la estructura de mis respuestas.",
  },
];

const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md"];

/** In-memory draft so the form survives route changes within the page load. */
let draft = {
  topicPrompt: DEFAULT_PROMPT,
  level: "B2",
  accent: ACCENTS[0],
  phonemes: [],
  contextFiles: [],
  micDeviceId: "",
};

/** DOM element references collected after the view is built. */
let els = null;

/** File names the user removed while extraction was still in flight. */
const removedFiles = new Set();

// ---------------------------------------------------------------------------
// View construction
// ---------------------------------------------------------------------------

/**
 * Initialize the config view inside the `#view-config` stage slot.
 * @param {HTMLElement} root - the `#view-config` element
 * @param {{ navigate: (path: string) => void }} router - shell router
 */
export function initConfigView(root, { navigate }) {
  root.innerHTML = "";
  root.appendChild(buildView());
  els = collectElements(root);
  bindEvents({ navigate });
  applyDraft();
  loadProfile();
  initAudio();
}

function buildView() {
  return h("div", { class: "config-view" }, [
    h("header", { class: "config-header" }, [
      h("h1", { class: "config-title" }, "Iniciar nueva práctica"),
      h("p", { class: "config-subtitle" }, "Describe el rol del AI Coach y configura tu sesión de práctica."),
    ]),

    // --- Role instruction ---
    h("section", { class: "form-section" }, [
      h("div", { class: "section-head" }, [
        h("h2", { class: "section-title" }, "Instrucción de Rol para el AI Coach"),
        h("span", { class: "char-counter", id: "topic-counter" }, `0/${TOPIC_MAX}`),
      ]),
      h("textarea", {
        id: "topic-prompt",
        class: "topic-textarea",
        maxlength: String(TOPIC_MAX),
        rows: 6,
        placeholder: "Describe el rol, el contexto y qué esperas del coach…",
      }),
      h("div", { class: "template-chips" }, [
        h("span", { class: "chips-label" }, "Plantillas:"),
        ...TEMPLATES.map((t) =>
          h("button", { type: "button", class: "chip", onclick: () => applyTemplate(t) }, t.name),
        ),
      ]),
    ]),

    // --- Level ---
    h("section", { class: "form-section" }, [
      h("div", { class: "section-head" }, [h("h2", { class: "section-title" }, "Nivel de inglés")]),
      h("div", { class: "level-row" }, [
        h(
          "select",
          { id: "level-select", class: "level-select" },
          LEVELS.map((l) => h("option", { value: l.value }, l.label)),
        ),
        h("span", { id: "level-hint", class: "level-hint", hidden: true }),
      ]),
    ]),

    // --- Dropzone (feature 104) ---
    h("section", { class: "form-section" }, [
      h("div", { class: "section-head" }, [h("h2", { class: "section-title" }, "Archivos de contexto")]),
      h("div", { id: "dropzone", class: "dropzone", tabindex: "0" }, [
        h("span", { class: "material-symbols-outlined dropzone-icon", "aria-hidden": "true" }, "cloud_upload"),
        h("p", { class: "dropzone-text" }, "Arrastra tu PDF, DOCX, TXT o MD aquí, o haz clic para elegir."),
        h("p", { class: "dropzone-sub" }, "El texto extraído se usa como contexto. El archivo nunca se sube."),
      ]),
      h("input", {
        id: "file-input",
        type: "file",
        accept: ACCEPTED_EXTENSIONS.join(","),
        multiple: true,
        hidden: true,
      }),
      h("div", { id: "file-chips", class: "file-chips" }),
    ]),

    // --- Accent + phonetic focus ---
    h("section", { class: "form-section" }, [
      h("div", { class: "section-head" }, [h("h2", { class: "section-title" }, "Pronunciación objetivo")]),
      h("div", { class: "accent-row" }, [
        h("label", { class: "field-label", for: "accent-select" }, "Acento objetivo"),
        h(
          "select",
          { id: "accent-select", class: "level-select" },
          ACCENTS.map((a) => h("option", { value: a }, a)),
        ),
      ]),
      h("div", { class: "phoneme-row" }, [
        h("span", { class: "chips-label" }, "Foco fonético"),
        h("div", { id: "phoneme-chips", class: "phoneme-chips" }),
      ]),
    ]),

    // --- Audio I/O ---
    h("section", { class: "form-section" }, [
      h("div", { class: "section-head" }, [h("h2", { class: "section-title" }, "Audio I/O")]),
      h("div", { class: "audio-block" }, [
        h("div", { class: "audio-row" }, [
          h("label", { class: "field-label", for: "mic-select" }, "Micrófono"),
          h("select", { id: "mic-select", class: "level-select" }, [h("option", { value: "" }, "Default")]),
        ]),
        h("div", { class: "meter-row" }, [
          h("div", { class: "meter-wrap" }, [h("div", { id: "meter-bar", class: "meter-bar" })]),
          h("span", { id: "meter-db", class: "meter-db" }, "— dB"),
        ]),
        h("div", { class: "audio-actions" }, [
          h("button", { id: "sound-test-btn", type: "button", class: "btn ghost" }, [
            h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "volume_up"),
            "Prueba de sonido",
          ]),
          h("span", { id: "sound-test-result", class: "sound-test-result" }),
        ]),
      ]),
    ]),

    // --- Start ---
    h("div", { class: "config-actions" }, [
      h("button", { id: "start-btn", type: "button", class: "btn start-btn", disabled: true }, [
        h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "arrow_forward"),
        "Iniciar práctica",
      ]),
    ]),
  ]);
}

function collectElements(root) {
  return {
    topic: root.querySelector("#topic-prompt"),
    counter: root.querySelector("#topic-counter"),
    levelSelect: root.querySelector("#level-select"),
    levelHint: root.querySelector("#level-hint"),
    accentSelect: root.querySelector("#accent-select"),
    phonemeChips: root.querySelector("#phoneme-chips"),
    dropzone: root.querySelector("#dropzone"),
    fileInput: root.querySelector("#file-input"),
    fileChips: root.querySelector("#file-chips"),
    micSelect: root.querySelector("#mic-select"),
    meterBar: root.querySelector("#meter-bar"),
    meterDb: root.querySelector("#meter-db"),
    soundTestBtn: root.querySelector("#sound-test-btn"),
    soundTestResult: root.querySelector("#sound-test-result"),
    startBtn: root.querySelector("#start-btn"),
  };
}

// ---------------------------------------------------------------------------
// Draft + form state
// ---------------------------------------------------------------------------

/** Restore the in-memory draft into the form (runs once at init). */
function applyDraft() {
  els.topic.value = draft.topicPrompt;
  els.counter.textContent = `${draft.topicPrompt.length}/${TOPIC_MAX}`;
  els.levelSelect.value = draft.level;
  els.accentSelect.value = draft.accent;
  updateStart();
}

/** Enable the start button only when topicPrompt is non-empty and level valid. */
function updateStart() {
  const valid = draft.topicPrompt.trim().length > 0 && LEVELS.some((l) => l.value === draft.level);
  els.startBtn.disabled = !valid;
}

/** Fill the textarea + level from a template chip. */
function applyTemplate(t) {
  els.topic.value = t.prompt;
  els.counter.textContent = `${t.prompt.length}/${TOPIC_MAX}`;
  els.levelSelect.value = t.level;
  draft.topicPrompt = t.prompt;
  draft.level = t.level;
  updateStart();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function bindEvents({ navigate }) {
  els.topic.addEventListener("input", () => {
    draft.topicPrompt = els.topic.value;
    els.counter.textContent = `${els.topic.value.length}/${TOPIC_MAX}`;
    updateStart();
  });

  els.levelSelect.addEventListener("change", () => {
    draft.level = els.levelSelect.value;
    updateStart();
  });

  els.accentSelect.addEventListener("change", () => {
    draft.accent = els.accentSelect.value;
  });

  els.phonemeChips.addEventListener("click", (e) => {
    const chip = e.target.closest(".phoneme-chip");
    if (!chip) return;
    chip.classList.toggle("active");
    draft.phonemes = [...els.phonemeChips.querySelectorAll(".phoneme-chip.active")].map((c) => c.dataset.phoneme);
  });

  els.dropzone.addEventListener("click", () => els.fileInput.click());
  els.dropzone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.fileInput.click();
    }
  });
  els.dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    els.dropzone.classList.add("drag-over");
  });
  els.dropzone.addEventListener("dragleave", () => els.dropzone.classList.remove("drag-over"));
  els.dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    els.dropzone.classList.remove("drag-over");
    handleFiles([...e.dataTransfer.files]);
  });
  els.fileInput.addEventListener("change", () => {
    handleFiles([...els.fileInput.files]);
    els.fileInput.value = "";
  });

  els.startBtn.addEventListener("click", () => openLaunchModal({ navigate }));
  els.soundTestBtn.addEventListener("click", runSoundTest);
}

// ---------------------------------------------------------------------------
// Profile-driven defaults (level, accuracy hint, phonetic focus)
// ---------------------------------------------------------------------------

/** Fetch /api/profile and apply level default, accuracy hint and phonemes. */
async function loadProfile() {
  try {
    const res = await fetch("/api/profile");
    if (!res.ok) return;
    const json = await res.json();
    const profile = json.profile ?? {};
    const stats = json.stats ?? {};

    const level = LEVELS.some((l) => l.value === profile.level) ? profile.level : "B2";
    els.levelSelect.value = level;
    draft.level = level;

    if (typeof stats.avg === "number" && stats.avg > 0) {
      els.levelHint.hidden = false;
      els.levelHint.textContent = `≈ ${stats.avg}% match/accuracy histórico`;
    }

    const phonemes = Array.isArray(profile.focusPhonemes)
      ? profile.focusPhonemes.filter((p) => typeof p === "string")
      : [];
    renderPhonemeChips(phonemes);
    updateStart();
  } catch {
    // offline: keep the defaults already applied
  }
}

/** Render the phonetic-focus chips from the profile (toggleable). */
function renderPhonemeChips(phonemes) {
  els.phonemeChips.innerHTML = "";
  if (phonemes.length === 0) {
    els.phonemeChips.appendChild(
      h("span", { class: "phoneme-empty" }, "Sin foco fonético configurado en el perfil."),
    );
    return;
  }
  for (const p of phonemes) {
    const chip = h("button", { type: "button", class: "chip phoneme-chip", dataset: { phoneme: p } }, p);
    if (draft.phonemes.includes(p)) chip.classList.add("active");
    els.phonemeChips.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// Dropzone (feature 104 consumption)
// ---------------------------------------------------------------------------

/** Read a File as a base64 data URL and strip the `data:<mime>;base64,` prefix. */
function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(new Error("No se pudo leer el archivo"));
    reader.readAsDataURL(file);
  });
}

/** Extract each dropped file via POST /api/files/extract (async, non-blocking). */
async function handleFiles(files) {
  for (const file of files) {
    removedFiles.delete(file.name);
    const ext = "." + (file.name.split(".").pop() || "").toLowerCase();
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      addFileChip({ name: file.name, size: file.size, status: "Tipo no soportado", ok: false });
      continue;
    }
    const chip = addFileChip({ name: file.name, size: file.size, status: "Extrayendo…", ok: null });
    try {
      const data = await readAsDataURL(file);
      const res = await fetch("/api/files/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, data }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "No se pudo extraer el archivo");
      if (removedFiles.has(file.name)) return;
      const ref = json.file;
      draft.contextFiles.push({ name: ref.name, size: ref.size, kind: ref.kind, textRef: ref.textRef });
      setFileChipStatus(chip, { status: "Listo", ok: true });
    } catch (err) {
      if (removedFiles.has(file.name)) return;
      setFileChipStatus(chip, { status: err.message, ok: false });
    }
  }
}

/** Append a file chip (name + size + status + remove button). */
function addFileChip(file) {
  const chip = h("div", { class: "file-chip" }, [
    h("span", { class: "material-symbols-outlined file-chip-icon", "aria-hidden": "true" }, "description"),
    h("span", { class: "file-chip-name" }, escapeHtml(file.name)),
    h("span", { class: "file-chip-size" }, formatBytes(file.size)),
    h("span", { class: "file-chip-status", dataset: { ok: String(file.ok ?? "") } }, file.status ?? ""),
    h(
      "button",
      {
        type: "button",
        class: "file-chip-remove",
        title: "Quitar",
        "aria-label": `Quitar ${file.name}`,
        onclick: () => {
          removedFiles.add(file.name);
          draft.contextFiles = draft.contextFiles.filter((f) => f.name !== file.name);
          chip.remove();
        },
      },
      "×",
    ),
  ]);
  els.fileChips.appendChild(chip);
  return chip;
}

function setFileChipStatus(chip, { status, ok }) {
  const statusEl = chip.querySelector(".file-chip-status");
  statusEl.textContent = status;
  statusEl.dataset.ok = String(ok);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Audio I/O: device selector, level meter, sound test
// ---------------------------------------------------------------------------

let meterStream = null;
let meterCtx = null;
let meterAnalyser = null;
let meterRaf = 0;
let meterPeakDb = -Infinity;

/** Populate the mic device list and start the live level meter. */
async function initAudio() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === "audioinput");
    els.micSelect.innerHTML = "";
    els.micSelect.appendChild(h("option", { value: "" }, "Default"));
    for (const d of mics) {
      els.micSelect.appendChild(h("option", { value: d.deviceId }, d.label || `Micrófono ${mics.indexOf(d) + 1}`));
    }
  } catch {
    // enumerateDevices unavailable — keep the default option
  }
  els.micSelect.addEventListener("change", () => {
    draft.micDeviceId = els.micSelect.value;
    startMeter();
  });
  startMeter();
}

/** Start the live dB meter on the selected input device (recorder-wave pipeline). */
async function startMeter() {
  stopMeter();
  try {
    const constraints = draft.micDeviceId ? { audio: { deviceId: { exact: draft.micDeviceId } } } : { audio: true };
    meterStream = await navigator.mediaDevices.getUserMedia(constraints);
    meterCtx = new AudioContext();
    meterAnalyser = meterCtx.createAnalyser();
    meterAnalyser.fftSize = 1024;
    meterCtx.createMediaStreamSource(meterStream).connect(meterAnalyser);
    const data = new Uint8Array(meterAnalyser.fftSize);
    const loop = () => {
      meterAnalyser.getByteTimeDomainData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) {
        const v = (data[i] - 128) / 128;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / data.length);
      const db = rms === 0 ? -Infinity : 20 * Math.log10(rms);
      meterPeakDb = Math.max(meterPeakDb, db);
      renderMeter(db);
      meterRaf = requestAnimationFrame(loop);
    };
    loop();
  } catch {
    els.meterDb.textContent = "mic no disponible";
    els.meterBar.style.width = "0%";
  }
}

function stopMeter() {
  cancelAnimationFrame(meterRaf);
  if (meterStream) {
    meterStream.getTracks().forEach((t) => t.stop());
    meterStream = null;
  }
  if (meterCtx) {
    meterCtx.close().catch(() => {});
    meterCtx = null;
  }
  meterAnalyser = null;
}

function renderMeter(db) {
  const clamped = Math.max(-60, Math.min(0, db));
  els.meterBar.style.width = `${((clamped + 60) / 60) * 100}%`;
  els.meterDb.textContent = db === -Infinity ? "— dB" : `${db.toFixed(1)} dB`;
}

/** Play a 440 Hz tone and capture it through the mic (recorder-wave pipeline). */
async function runSoundTest() {
  els.soundTestBtn.disabled = true;
  els.soundTestResult.textContent = "Reproduciendo tono…";
  try {
    if (!meterStream) await startMeter();
    if (!meterCtx) throw new Error("Micrófono no disponible");
    const recorder = new WaveRecorder();
    await recorder.start();
    const osc = meterCtx.createOscillator();
    const gain = meterCtx.createGain();
    osc.frequency.value = 440;
    osc.type = "sine";
    gain.gain.value = 0.25;
    osc.connect(gain).connect(meterCtx.destination);
    osc.start();
    await new Promise((r) => setTimeout(r, 1500));
    osc.stop();
    const blob = recorder.stop();
    const { db, sampleRate } = await wavPeakDb(blob);
    const peak = db === -Infinity ? "—" : `${db.toFixed(1)} dB`;
    els.soundTestResult.textContent = `Tono capturado · pico ${peak} (${sampleRate} Hz)`;
  } catch (err) {
    els.soundTestResult.textContent = err.message;
  } finally {
    els.soundTestBtn.disabled = false;
  }
}

/** Compute the peak level (dB) of a WAV blob produced by WaveRecorder. */
function wavPeakDb(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const view = new DataView(reader.result);
        const sampleRate = view.getUint32(24, true);
        const bits = view.getUint16(34, true);
        const dataLen = view.getUint32(40, true);
        const bytesPerSample = bits / 8;
        const n = Math.floor(dataLen / bytesPerSample);
        let peak = 0;
        for (let i = 0; i < n; i++) {
          let v;
          if (bits === 16) v = view.getInt16(44 + i * 2, true) / 0x8000;
          else if (bits === 8) v = (view.getUint8(44 + i) - 128) / 128;
          else if (bits === 32) v = view.getFloat32(44 + i * 4, true);
          else continue;
          peak = Math.max(peak, Math.abs(v));
        }
        const db = peak === 0 ? -Infinity : 20 * Math.log10(peak);
        resolve({ db, sampleRate });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = () => reject(new Error("No se pudo leer la captura"));
    reader.readAsArrayBuffer(blob);
  });
}

// ---------------------------------------------------------------------------
// Launch modal ("Iniciando Sala de Audio")
// ---------------------------------------------------------------------------

/** Check whisper availability; returns true when the Web Speech fallback is needed. */
async function checkWhisper() {
  try {
    const res = await fetch("/api/whisper/status");
    if (!res.ok) return true;
    const json = await res.json();
    return !(json.available && json.modelReady);
  } catch {
    return true; // assume fallback when the server is unreachable
  }
}

/**
 * Open the launch modal with animated steps (DSP 48kHz → Whisper Aligner →
 * Role Topic). Step 2 resolves whisper availability and announces the Web
 * Speech fallback when needed. "Entrar al Estudio" calls POST /api/session/start
 * and navigates to #/practice/<id>; "Cancelar" keeps the draft in local state
 * and creates no session.
 */
function openLaunchModal({ navigate }) {
  const overlay = h("div", { class: "overlay launch-modal", id: "launch-modal" }, [
    h("div", { class: "overlay-panel launch-panel", role: "dialog", "aria-modal": "true", "aria-label": "Iniciando Sala de Audio" }, [
      h("div", { class: "overlay-head" }, [h("h2", { class: "overlay-title" }, "Iniciando Sala de Audio")]),
      h("div", { class: "launch-body" }, [
        h("ol", { class: "launch-steps" }, [
          h("li", { class: "launch-step", dataset: { step: "dsp" } }, [
            h("span", { class: "material-symbols-outlined launch-step-icon", "aria-hidden": "true" }, "graphic_eq"),
            h("div", { class: "launch-step-text" }, [
              h("div", { class: "launch-step-name" }, "DSP 48kHz"),
              h("div", { class: "launch-step-detail" }, "Preparando pipeline de audio"),
            ]),
          ]),
          h("li", { class: "launch-step", dataset: { step: "aligner" } }, [
            h("span", { class: "material-symbols-outlined launch-step-icon", "aria-hidden": "true" }, "record_voice_over"),
            h("div", { class: "launch-step-text" }, [
              h("div", { class: "launch-step-name" }, "Whisper Aligner"),
              h("div", { class: "launch-step-detail" }, "Verificando motor de reconocimiento"),
            ]),
          ]),
          h("li", { class: "launch-step", dataset: { step: "topic" } }, [
            h("span", { class: "material-symbols-outlined launch-step-icon", "aria-hidden": "true" }, "tune"),
            h("div", { class: "launch-step-text" }, [
              h("div", { class: "launch-step-name" }, "Role Topic"),
              h("div", { class: "launch-step-detail" }, "Preparando el rol y el tópico"),
            ]),
          ]),
        ]),
        h("div", { id: "launch-error", class: "launch-error", hidden: true }),
      ]),
      h("div", { class: "launch-actions" }, [
        h("button", { id: "launch-cancel", type: "button", class: "btn ghost" }, "Cancelar"),
        h("button", { id: "launch-enter", type: "button", class: "btn start-btn", disabled: true }, [
          h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "arrow_forward"),
          "Entrar al Estudio",
        ]),
      ]),
    ]),
  ]);
  document.body.appendChild(overlay);
  document.body.classList.add("overlay-open");

  const steps = overlay.querySelectorAll(".launch-step");
  const enterBtn = overlay.querySelector("#launch-enter");
  const cancelBtn = overlay.querySelector("#launch-cancel");
  const errorEl = overlay.querySelector("#launch-error");
  let cancelled = false;

  const close = () => {
    cancelled = true;
    overlay.remove();
    document.body.classList.remove("overlay-open");
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => {
    if (e.key === "Escape" && overlay.isConnected) close();
  };

  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener("keydown", onKey);

  // --- animated steps ---
  const activate = (i) => steps[i].classList.add("active");
  const complete = (i) => {
    steps[i].classList.add("done");
    steps[i].classList.remove("active");
  };

  activate(0);
  setTimeout(() => {
    if (cancelled) return;
    complete(0);
    activate(1);
    checkWhisper().then((fallback) => {
      if (cancelled) return;
      const detail = steps[1].querySelector(".launch-step-detail");
      detail.textContent = fallback ? "Whisper no instalado · fallback Web Speech" : "Whisper listo";
      complete(1);
      activate(2);
      setTimeout(() => {
        if (cancelled) return;
        complete(2);
        enterBtn.disabled = false;
      }, 600);
    });
  }, 600);

  // --- enter the studio ---
  enterBtn.addEventListener("click", async () => {
    enterBtn.disabled = true;
    enterBtn.textContent = "Creando sesión…";
    errorEl.hidden = true;
    try {
      const res = await fetch("/api/session/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topicPrompt: draft.topicPrompt,
          level: draft.level,
          contextFiles: draft.contextFiles,
          accent: draft.accent,
          focusPhonemes: draft.phonemes,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "No se pudo iniciar la sesión");
      overlay.remove();
      document.body.classList.remove("overlay-open");
      document.removeEventListener("keydown", onKey);
      navigate(`#/practice/${json.sessionId}`);
    } catch (err) {
      errorEl.hidden = false;
      errorEl.textContent = err.message;
      enterBtn.disabled = false;
      enterBtn.innerHTML = "";
      enterBtn.append(
        h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "arrow_forward"),
        "Entrar al Estudio",
      );
    }
  });
}