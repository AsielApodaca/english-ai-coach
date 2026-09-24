/**
 * Audio dock for the karaoke practice view (feature 105 / CU2).
 *
 * Bottom dock with:
 *   - 32-bar canvas waveform: idle slate pulse, cyan sine while the AI speaks,
 *     lime→amber VU meter while the user records.
 *   - 64px mic orb (green / amber) as a pure STATUS indicator: hands-free
 *     turns start and stop listening on their own (VAD), so the orb is NOT
 *     clickable — it just shows "your turn" (green pulse) and "listening"
 *     (amber ring + live VU).
 *   - Tempo segmented control (0.75× / 1× / 1.25×) applied to coach TTS.
 *   - Mic label + live dB monitor.
 *   - Assistance pills: "Reintentar fragmento" (retry) and "Finalizar Sesión".
 *
 * The dock is effectful UI only: it wires the two assistance pills up and
 * exposes a small imperative API for the practice view to drive its state.
 */

import { h } from "./dom.js";

const BAR_COUNT = 32;
const ORB_SIZE = 64;

/**
 * Create the audio dock inside `root`.
 *
 * @param {HTMLElement} root
 * @param {{
 *   onRetry: () => void,
 *   onFinish: () => void,
 * }} handlers
 * @param {{ rate?: number }} [opts] - initial tempo (default 1)
 * @returns {{
 *   setMode: (mode: "idle"|"ai"|"recording") => void,
 *   setOrbEnabled: (enabled: boolean) => void,
 *   setMicLabel: (label: string) => void,
 *   setVU: (db: number) => void,
 *   getRate: () => number,
 *   setRate: (rate: number) => void,
 *   setRetryEnabled: (enabled: boolean) => void,
 *   startVisualizer: () => void,
 *   stopVisualizer: () => void,
 *   destroy: () => void,
 * }}
 */
export function createAudioDock(root, handlers, { rate: initialRate = 1 } = {}) {
  const canvas = h("canvas", { class: "dock-waveform", width: "640", height: "48", "aria-hidden": "true" });
  const ctx = canvas.getContext("2d");

  const orbBtn = h("button", { type: "button", class: "orb", disabled: true, title: "A la espera", "aria-label": "Estado del micrófono" }, [
    h("span", { class: "material-symbols-outlined orb-icon", "aria-hidden": "true" }, "mic"),
  ]);

  const micLabel = h("span", { class: "dock-mic-label" }, "Micrófono");
  const micDb = h("span", { class: "dock-mic-db" }, "— dB");

  const tempoBtns = [0.75, 1, 1.25].map((rate) =>
    h(
      "button",
      {
        type: "button",
        class: "dock-tempo-btn",
        dataset: { rate: String(rate) },
        onclick: () => selectTempo(rate),
      },
      `${rate}×`,
    ),
  );

  const retryBtn = h(
    "button",
    { type: "button", class: "pill dock-pill", disabled: true, onclick: () => handlers.onRetry() },
    [h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "replay"), "Reintentar fragmento"],
  );
  const finishBtn = h(
    "button",
    { type: "button", class: "pill dock-pill", onclick: () => handlers.onFinish() },
    [h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "flag"), "Finalizar Sesión"],
  );

  const dock = h("div", { class: "audio-dock" }, [
    canvas,
    h("div", { class: "dock-controls" }, [
      h("div", { class: "dock-mic" }, [
        h("span", { class: "material-symbols-outlined dock-mic-icon", "aria-hidden": "true" }, "mic"),
        micLabel,
        micDb,
      ]),
      orbBtn,
      h("div", { class: "dock-tempo", role: "group", "aria-label": "Tempo" }, tempoBtns),
    ]),
    h("div", { class: "dock-pills" }, [retryBtn, finishBtn]),
  ]);
  root.appendChild(dock);

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** @type {"idle"|"ai"|"recording"} */
  let mode = "idle";
  let rate = 1;
  let raf = 0;
  let phase = 0;
  let vu = -60; // current dB for the recording meter
  let destroyed = false;

  // -------------------------------------------------------------------------
  // Orb (status indicator — NOT clickable; turns are hands-free, feature 105)
  // -------------------------------------------------------------------------

  function selectTempo(value) {
    rate = value;
    for (const btn of tempoBtns) btn.classList.toggle("active", Number(btn.dataset.rate) === value);
    // Persist as a device pref (feature 108) so the settings tab stays in sync.
    localStorage.setItem("engcoach.tempo", String(value));
    window.dispatchEvent(new CustomEvent("engcoach:settings-changed"));
  }
  selectTempo(initialRate);

  // -------------------------------------------------------------------------
  // Waveform visualizer (32 bars)
  // -------------------------------------------------------------------------

  function draw() {
    if (destroyed) return;
    const w = canvas.width;
    const hh = canvas.height;
    ctx.clearRect(0, 0, w, hh);
    const gap = 3;
    const barW = (w - gap * (BAR_COUNT - 1)) / BAR_COUNT;
    const mid = hh / 2;

    for (let i = 0; i < BAR_COUNT; i++) {
      let amp;
      let color;
      if (mode === "recording") {
        // VU meter: lime → amber as the level climbs.
        const t = Math.max(0, Math.min(1, (vu + 60) / 60));
        amp = 0.15 + 0.85 * t;
        color = t > 0.75 ? "#f59e0b" : "#10b981";
      } else if (mode === "ai") {
        // Cyan sine wave sweeping left→right.
        const x = (i / BAR_COUNT) * Math.PI * 2;
        amp = 0.35 + 0.65 * Math.abs(Math.sin(x - phase));
        color = "#06b6d4";
      } else {
        // Idle: soft slate pulse.
        amp = 0.12 + 0.1 * Math.sin(phase * 0.8 + i * 0.35);
        color = "#334155";
      }
      const barH = Math.max(2, amp * hh * 0.9);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.roundRect(i * (barW + gap), mid - barH / 2, barW, barH, 2);
      ctx.fill();
    }
    phase += 0.12;
    raf = requestAnimationFrame(draw);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  return {
    setMode(m) {
      mode = m;
      // Single source of truth for the amber orb: entering "recording" latches
      // it, ANY other mode (or disable) clears it. Because the orb is not
      // clickable, every recording is driven through this API — a stale amber
      // can never survive a phase change.
      if (m === "recording") {
        orbBtn.classList.add("recording");
      } else {
        orbBtn.classList.remove("recording");
      }
      dock.dataset.mode = m;
    },
    setOrbEnabled(enabled) {
      // Mark the turn as active for the indicator; the orb itself is a
      // disabled (non-clickable) element that just reflects state.
      orbBtn.disabled = !enabled;
      if (enabled) {
        orbBtn.classList.add("armed");
      } else {
        orbBtn.classList.remove("armed");
        orbBtn.classList.remove("recording");
      }
      // Hands-free hint: the turn is being listened to automatically, no press
      // required (feature 105 — user chose auto-listen over push-to-talk).
      orbBtn.title = enabled ? "La IA te está escuchando" : "A la espera";
      if (enabled && mode === "idle") micLabel.textContent = "Te toca a ti…";
    },
    setMicLabel(label) {
      micLabel.textContent = label;
    },
    setVU(db) {
      vu = Number.isFinite(db) ? db : -60;
      micDb.textContent = vu === -Infinity ? "— dB" : `${vu.toFixed(1)} dB`;
    },
    getRate() {
      return rate;
    },
    setRate(value) {
      selectTempo(value);
    },
    setRetryEnabled(enabled) {
      retryBtn.disabled = !enabled;
    },
    startVisualizer() {
      if (!raf) raf = requestAnimationFrame(draw);
    },
    stopVisualizer() {
      cancelAnimationFrame(raf);
      raf = 0;
    },
    destroy() {
      destroyed = true;
      cancelAnimationFrame(raf);
      raf = 0;
      dock.remove();
    },
  };
}