/**
 * Session configuration view (feature 103 / CU1) — the product home.
 *
 * Layout follows the Stitch design "Configurar Sesión con AI Coach -
 * Minimalist": a centered hero headline, scenario pills, a Claude/ChatGPT-style
 * prompt box (textarea + toolbar with CEFR level, attach, live mic dB, clear,
 * char counter, start button) and a subtle meta strip (accent / phonetic focus
 * / history). Files can be attached via the toolbar button OR by dragging
 * anywhere on the window: a full-screen dimmed overlay announces the drop zone.
 *
 * The user describes the coach role (topicPrompt), picks a CEFR level, may
 * attach context files (feature 104), verifies the microphone, and starts a
 * practice. "Iniciar práctica" stays disabled until topicPrompt is non-empty
 * and the level is valid; pressing it opens the "Iniciando Sala de Audio"
 * launch modal and only "Entrar al Estudio" creates the session via
 * POST /api/session/start (CU3: no session is created before that).
 *
 * The config draft lives in module state only (no disk autosave — feature 109
 * owns the data/tmp draft), so leaving the view and returning within the same
 * page load restores the form.
 */

import { h, escapeHtml } from "./dom.js";
import { WaveRecorder } from "../speech/recorder-wave.js";

const TOPIC_MAX = 6000;
const DEFAULT_PROMPT =
  "Simula ser un Engineering Manager senior de Google haciéndome una entrevista de comportamiento técnica. Profundiza en manejo de desacuerdos y trade-offs arquitectónicos.";

const LEVELS = [
  { value: "A1", label: "Nivel A1" },
  { value: "A2", label: "Nivel A2" },
  { value: "B1", label: "Nivel B1" },
  { value: "B2", label: "Nivel B2 (Working)" },
  { value: "C1", label: "Nivel C1 (Advanced)" },
  { value: "C2", label: "Nivel C2 (Mastery)" },
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
    icon: "psychology",
    tint: "secondary",
    topic: "Behavioral: Disagreement with Staff Architect & Roadmap Trade-offs",
    level: "B2",
    prompt:
      "Simula ser un Engineering Manager senior de Google evaluando mi liderazgo técnico, trade-offs de arquitectura y gestión de conflictos en equipos distribuidos bajo presión de plazos.",
  },
  {
    name: "System Design Defense",
    icon: "hub",
    tint: "primary",
    topic: "Distributed Consensus & Split-Brain Mitigation Strategy",
    level: "C1",
    prompt:
      "Actúa como Principal Systems Architect. Desafía mi defensa de diseño para un motor de persistencia distribuido tolerante a particiones (Raft/Paxos) con réplicas multirregión y consistencia eventual.",
  },
  {
    name: "Client Demo Pitch",
    icon: "swipe_vertical",
    tint: "tertiary",
    topic: "Enterprise Demo: Cost Reduction & Latency SLA Assurances",
    level: "B2",
    prompt:
      "Eres el CTO exigente de un cliente Enterprise escéptico. Te presento una migración completa de monolito legacy a Kubernetes serverless con observabilidad OpenTelemetry.",
  },
  {
    name: "Behavioral Leadership",
    icon: "supervisor_account",
    tint: "secondary",
    topic: "Handling Cross-Functional Pushback & Sprint Velocity",
    level: "B2",
    prompt:
      "Evalúa mis habilidades de influencia, mentoría a ingenieros juniors y comunicación asertiva ante requerimientos contradictorios de Product Management.",
  },
];

const ACCEPTED_EXTENSIONS = [".pdf", ".docx", ".txt", ".md"];

/** In-memory draft so the form survives route changes within the page load. */
let draft = {
  topicPrompt: DEFAULT_PROMPT,
  topic: "Google EM Mock Interview",
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
  initDropOverlay();
}

function buildView() {
  return h("div", { class: "config-view" }, [
    // --- Centered hero ---
    h("div", { class: "config-hero" }, [
      h("h1", { class: "config-title" }, "Preparar sesión con AI Coach"),
      h(
        "p",
        { class: "config-subtitle" },
        "Entrena fluidez y fonética en tiempo real con audio natural bidireccional, transcripción fonética IPA y corrección acústica asistida.",
      ),
    ]),

    // --- Scenario pills ---
    h("div", { class: "template-pills", id: "prompt-chips" }, [
      ...TEMPLATES.map((t) =>
        h(
          "button",
          {
            type: "button",
            class: "pill",
            dataset: { tint: t.tint },
            onclick: () => applyTemplate(t),
          },
          [
            h("span", { class: "material-symbols-outlined pill-icon", "aria-hidden": "true" }, t.icon),
            h("span", { class: "pill-label" }, t.name),
          ],
        ),
      ),
    ]),

    // --- Prompt box (Claude/ChatGPT style) ---
    h("div", { class: "prompt-box", id: "prompt-box" }, [
      h("input", {
        id: "file-input",
        type: "file",
        accept: ACCEPTED_EXTENSIONS.join(","),
        multiple: true,
        hidden: true,
      }),
      h("div", { id: "file-chips", class: "file-chips" }),
      h("textarea", {
        id: "prompt-input",
        class: "prompt-textarea",
        maxlength: String(TOPIC_MAX),
        rows: 3,
        placeholder: "Describe el rol o tema para el Coach (o arrastra archivos de contexto)...",
      }),
      h("div", { class: "prompt-toolbar" }, [
        h("div", { class: "toolbar-left" }, [
          // CEFR level dropdown
          h("div", { class: "cefr-wrap" }, [
            h(
              "select",
              { id: "level-select", class: "cefr-select" },
              LEVELS.map((l) => h("option", { value: l.value }, l.label)),
            ),
            h("span", { class: "material-symbols-outlined cefr-caret", "aria-hidden": "true" }, "expand_more"),
          ]),
          // Attach button
          h(
            "button",
            { id: "attach-btn", type: "button", class: "toolbar-icon-btn", title: "Adjuntar documento de contexto" },
            [h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "attach_file")],
          ),
          // Mic status indicator (opens audio popover)
          h(
            "button",
            { id: "mic-indicator", type: "button", class: "mic-indicator", title: "Micrófono y prueba de sonido" },
            [
              h("span", { class: "material-symbols-outlined mic-icon", "aria-hidden": "true" }, "mic"),
              h("span", { id: "mic-db", class: "mic-db" }, "— dB"),
            ],
          ),
          // Clear button
          h(
            "button",
            { id: "clear-prompt-btn", type: "button", class: "toolbar-text-btn" },
            "Limpiar",
          ),
        ]),
        h("div", { class: "toolbar-right" }, [
          h("span", { id: "topic-counter", class: "char-counter" }, `0 / ${TOPIC_MAX}`),
          h("button", { id: "start-btn", type: "button", class: "btn start-btn", disabled: true }, [
            h("span", { class: "material-symbols-outlined start-btn-icon", "aria-hidden": "true" }, "graphic_eq"),
            h("span", { class: "start-btn-label" }, "Iniciar práctica"),
            h("kbd", {}, "↵"),
          ]),
        ]),
      ]),
      // --- Audio I/O popover (device select + sound test + level meter) ---
      h("div", { id: "audio-popover", class: "audio-popover", hidden: true }, [
        h("div", { class: "audio-popover-head" }, [
          h("label", { class: "field-label", for: "mic-select" }, "Micrófono"),
          h(
            "select",
            { id: "mic-select", class: "level-select" },
            [h("option", { value: "" }, "Default")],
          ),
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

    // --- Meta strip ---
    h("div", { class: "config-meta" }, [
      h("div", { class: "meta-col" }, [
        h("div", { class: "meta-label" }, "Acento Objetivo"),
        h("div", { class: "meta-value" }, ACCENTS[0]),
        h("div", { class: "meta-sub" }, "ARPA / IPA CMUDict"),
      ]),
      h("div", { class: "meta-col" }, [
        h("div", { class: "meta-label" }, "Foco Fonético"),
        h("div", { id: "phoneme-chips", class: "phoneme-chips" }),
        h("div", { class: "meta-sub" }, "Confusiones hispanas"),
      ]),
      h("div", { class: "meta-col" }, [
        h("div", { class: "meta-head" }, [
          h("span", { class: "meta-label" }, "Historial"),
          h("span", { id: "history-score", class: "history-score" }),
        ]),
        h("div", { class: "history-bar" }, [h("div", { id: "history-fill", class: "history-fill" })]),
        h("div", { id: "history-last", class: "meta-sub" }, ""),
      ]),
    ]),
  ]);
}

function collectElements(root) {
  return {
    prompt: root.querySelector("#prompt-input"),
    counter: root.querySelector("#topic-counter"),
    levelSelect: root.querySelector("#level-select"),
    phonemeChips: root.querySelector("#phoneme-chips"),
    fileInput: root.querySelector("#file-input"),
    attachBtn: root.querySelector("#attach-btn"),
    fileChips: root.querySelector("#file-chips"),
    micIndicator: root.querySelector("#mic-indicator"),
    micDb: root.querySelector("#mic-db"),
    audioPopover: root.querySelector("#audio-popover"),
    micSelect: root.querySelector("#mic-select"),
    meterBar: root.querySelector("#meter-bar"),
    meterDb: root.querySelector("#meter-db"),
    soundTestBtn: root.querySelector("#sound-test-btn"),
    soundTestResult: root.querySelector("#sound-test-result"),
    clearBtn: root.querySelector("#clear-prompt-btn"),
    startBtn: root.querySelector("#start-btn"),
    historyScore: root.querySelector("#history-score"),
    historyFill: root.querySelector("#history-fill"),
    historyLast: root.querySelector("#history-last"),
    promptBox: root.querySelector("#prompt-box"),
  };
}

// ---------------------------------------------------------------------------
// Draft + form state
// ---------------------------------------------------------------------------

/** Restore the in-memory draft into the form (runs once at init). */
function applyDraft() {
  els.prompt.value = draft.topicPrompt;
  els.counter.textContent = `${draft.topicPrompt.length} / ${TOPIC_MAX}`;
  els.levelSelect.value = draft.level;
  updateStart();
}

/** Enable the start button only when topicPrompt is non-empty and level valid. */
function updateStart() {
  const valid = draft.topicPrompt.trim().length > 0 && LEVELS.some((l) => l.value === draft.level);
  els.startBtn.disabled = !valid;
}

/** Fill the textarea + level + persona topic from a template pill. */
function applyTemplate(t) {
  els.prompt.value = t.prompt;
  els.counter.textContent = `${t.prompt.length} / ${TOPIC_MAX}`;
  els.levelSelect.value = t.level;
  draft.topicPrompt = t.prompt;
  draft.topic = t.topic;
  draft.level = t.level;
  updateStart();
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function bindEvents({ navigate }) {
  els.prompt.addEventListener("input", () => {
    draft.topicPrompt = els.prompt.value;
    els.counter.textContent = `${els.prompt.value.length} / ${TOPIC_MAX}`;
    updateStart();
  });

  els.levelSelect.addEventListener("change", () => {
    draft.level = els.levelSelect.value;
    updateStart();
  });

  els.phonemeChips.addEventListener("click", (e) => {
    const chip = e.target.closest(".phoneme-chip");
    if (!chip) return;
    chip.classList.toggle("active");
    draft.phonemes = [...els.phonemeChips.querySelectorAll(".phoneme-chip.active")].map((c) => c.dataset.phoneme);
  });

  els.attachBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => {
    handleFiles([...els.fileInput.files]);
    els.fileInput.value = "";
  });

  els.clearBtn.addEventListener("click", () => {
    els.prompt.value = "";
    els.counter.textContent = `0 / ${TOPIC_MAX}`;
    draft.topicPrompt = "";
    updateStart();
    els.prompt.focus();
  });

  els.micIndicator.addEventListener("click", () => {
    els.audioPopover.hidden = !els.audioPopover.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!els.audioPopover.hidden && !els.audioPopover.contains(e.target) && !els.micIndicator.contains(e.target)) {
      els.audioPopover.hidden = true;
    }
  });

  els.startBtn.addEventListener("click", () => openLaunchModal({ navigate }));
  els.soundTestBtn.addEventListener("click", runSoundTest);
}

// ---------------------------------------------------------------------------
// Profile-driven defaults (level, history, phonetic focus)
// ---------------------------------------------------------------------------

/** Fetch /api/profile and apply level default, history strip and phonemes. */
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

    // History meta column: avg score bar + last topic.
    if (typeof stats.avg === "number" && stats.avg > 0) {
      const avg = Math.round(stats.avg);
      els.historyScore.textContent = `${avg.toFixed(1)}%`;
      els.historyFill.style.width = `${Math.min(100, avg)}%`;
      const lastTopic = Array.isArray(stats.recentTopics) && stats.recentTopics[0];
      els.historyLast.textContent = lastTopic ? `Último: ${lastTopic}` : "";
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
    els.phonemeChips.appendChild(h("span", { class: "phoneme-empty" }, "—"));
    return;
  }
  for (const p of phonemes) {
    const chip = h("button", { type: "button", class: "phoneme-chip", dataset: { phoneme: p } }, p);
    if (draft.phonemes.includes(p)) chip.classList.add("active");
    els.phonemeChips.appendChild(chip);
  }
}

// ---------------------------------------------------------------------------
// Drag & drop: full-screen dimmed overlay
// ---------------------------------------------------------------------------

let dragOverlayEl = null;

/**
 * Install the global drag-and-drop overlay. Dragging a file anywhere on the
 * window dims the whole screen (fixed, backdrop-blur) and announces the drop
 * zone: "suelta el archivo en cualquier parte". Dropping hands the files to the
 * same extraction pipeline as the attach button (feature 104).
 */
function initDropOverlay() {
  dragOverlayEl = h("div", { class: "drop-overlay", id: "drop-overlay", hidden: true }, [
    h("div", { class: "drop-overlay-card" }, [
      h("div", { class: "drop-overlay-icon" }, [
        h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "cloud_upload"),
      ]),
      h("div", { class: "drop-overlay-text" }, [
        h("p", { class: "drop-overlay-title" }, "Drop any file here and add it to the conversation"),
        h("p", { class: "drop-overlay-sub" }, "PDF, DOCX, TXT, MD soportados"),
      ]),
    ]),
  ]);
  document.body.appendChild(dragOverlayEl);

  let dragCounter = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragCounter++;
    if (dragCounter > 0) dragOverlayEl.hidden = false;
  });
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragOverlayEl.hidden = true;
      dragCounter = 0;
    }
  });
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragCounter = 0;
    dragOverlayEl.hidden = true;
    if (e.dataTransfer && e.dataTransfer.files.length) {
      handleFiles([...e.dataTransfer.files]);
    }
  });
}

// ---------------------------------------------------------------------------
// File attachment (feature 104 consumption)
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
    h(
      "span",
      {
        class: "material-symbols-outlined file-chip-icon",
        dataset: { ok: String(file.ok ?? "") },
        "aria-hidden": "true",
      },
      file.ok === false ? "error" : "attach_file",
    ),
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
          if (els.fileChips.childElementCount === 0) els.fileChips.hidden = true;
        },
      },
      "×",
    ),
  ]);
  els.fileChips.appendChild(chip);
  els.fileChips.hidden = false;
  return chip;
}

function setFileChipStatus(chip, { status, ok }) {
  const statusEl = chip.querySelector(".file-chip-status");
  statusEl.textContent = status;
  statusEl.dataset.ok = String(ok);
  const icon = chip.querySelector(".file-chip-icon");
  if (icon) icon.dataset.ok = String(ok);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Audio I/O: device selector, live dB meter, sound test
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
  const dbText = db === -Infinity ? "—" : `${db.toFixed(1)}`;
  els.meterDb.textContent = `${dbText} dB`;
  els.micDb.textContent = `${dbText} dB`;
  els.micDb.classList.toggle("muted", db === -Infinity);
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
 * Open the launch modal (Stitch "Iniciando Sala de Audio" design): persona tile
 * with the selected scenario, the CEFR level, and three status rows
 * (DSP Audio → Whisper Aligner → Role Topic) that resolve in order. Step 2
 * checks whisper availability and announces the Web Speech fallback when
 * needed. "Entrar al Estudio" calls POST /api/session/start and navigates to
 * #/practice/<id>; "Cancelar" keeps the draft in local state and creates no
 * session.
 */
function openLaunchModal({ navigate }) {
  const overlay = h("div", { class: "overlay launch-modal", id: "launch-modal" }, [
    h("div", { class: "overlay-panel launch-panel", role: "dialog", "aria-modal": "true", "aria-label": "Iniciando Sala de Audio" }, [
      h("div", { class: "launch-head" }, [
        h("div", { class: "launch-head-icon" }, [
          h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "graphic_eq"),
        ]),
        h("div", { class: "launch-head-text" }, [
          h("h2", { class: "launch-title" }, "Iniciando Sala de Audio"),
          h("p", { class: "launch-subtitle" }, [
            "Conectando con Coach de voz en nivel ",
            h("strong", { class: "launch-level" }, draft.level),
          ]),
        ]),
      ]),
      h("div", { class: "launch-status" }, [
        h("div", { class: "launch-row", dataset: { step: "dsp" } }, [
          h("span", { class: "launch-row-label" }, "DSP Audio:"),
          h("span", { class: "launch-row-value" }, "48kHz WebAudio"),
        ]),
        h("div", { class: "launch-row", dataset: { step: "aligner" } }, [
          h("span", { class: "launch-row-label" }, "Whisper Aligner:"),
          h("span", { class: "launch-row-value" }, "Verificando…"),
        ]),
        h("div", { class: "launch-row", dataset: { step: "topic" } }, [
          h("span", { class: "launch-row-label" }, "Role Topic:"),
          h("span", { class: "launch-row-value launch-topic" }, draft.topic || draft.topicPrompt.slice(0, 40)),
        ]),
      ]),
      h("div", { id: "launch-error", class: "launch-error", hidden: true }),
      h("div", { class: "launch-actions" }, [
        h("button", { id: "launch-cancel", type: "button", class: "btn ghost" }, "Cancelar"),
        h("button", { id: "launch-enter", type: "button", class: "btn enter-btn", disabled: true }, [
          h("span", { class: "enter-label" }, "Entrar al Estudio"),
          h("span", { class: "material-symbols-outlined enter-icon", "aria-hidden": "true" }, "arrow_forward"),
        ]),
      ]),
    ]),
  ]);
  document.body.appendChild(overlay);
  document.body.classList.add("overlay-open");

  const rows = overlay.querySelectorAll(".launch-row");
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

  // --- resolve rows in sequence ---
  const setValue = (name, value, ready) => {
    const valueEl = rows[name].querySelector(".launch-row-value");
    valueEl.textContent = value;
    rows[name].classList.add("done");
    if (ready) valueEl.classList.add("ready");
  };

  rows[0].classList.add("active");
  setTimeout(() => {
    if (cancelled) return;
    setValue(0, "48kHz WebAudio Ready", true);
    rows[1].classList.add("active");
    checkWhisper().then((fallback) => {
      if (cancelled) return;
      setValue(1, fallback ? "Fallback Web Speech" : "Synchronized", !fallback);
      rows[2].classList.add("active");
      setTimeout(() => {
        if (cancelled) return;
        setValue(2, draft.topic || draft.topicPrompt.slice(0, 40), true);
        enterBtn.disabled = false;
      }, 600);
    });
  }, 600);

  // --- enter the studio ---
  enterBtn.addEventListener("click", async () => {
    enterBtn.disabled = true;
    enterBtn.querySelector(".enter-label").textContent = "Creando sesión…";
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
      const label = enterBtn.querySelector(".enter-label");
      label.textContent = "Entrar al Estudio";
    }
  });
}