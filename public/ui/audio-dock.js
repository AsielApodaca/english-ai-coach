/**
 * Audio dock for the karaoke practice view (feature 105 / CU2, feature 111).
 *
 * Bottom dock with:
 *   - 32-bar canvas waveform: idle slate pulse, cyan sine while the AI speaks,
 *     lime→amber VU meter while the user records.
 *   - 64px mic orb = the PUSH-TO-TALK button (feature 111): pressing it (or
 *     holding SPACE anywhere) starts the capture of the turn in flight and
 *     releasing it cuts the capture. It only accepts presses while the turn
 *     is armed (`setOrbEnabled(true)`), i.e. never on its own. Three visual
 *     states: armed/"your turn" (green pulse), recording (amber + expanding
 *     rings + VU), coach speaking (idle, orb dimmed).
 *   - Tempo segmented control (0.75× / 1× / 1.25×) applied to coach TTS.
 *   - Mic label + live dB monitor.
 *   - Assistance pills: "Reintentar fragmento" (retry) and "Finalizar Sesión".
 *
 * The dock is effectful UI only: it wires the two assistance pills and the
 * PTT button up and exposes a small imperative API for the practice view to
 * drive its state.
 *
 * @typedef {(source?: string) => unknown} PttHandler
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
 *   onPttPress?: PttHandler,
 *   onPttRelease?: PttHandler,
 * }} handlers
 *   `onPttPress`/`onPttRelease` (feature 111) route the mic button's
 *   pointerdown/pointerup to the capture turn in the practice view.
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

  const orbBtn = h(
    "button",
    {
      type: "button",
      class: "orb",
      disabled: true,
      title: "A la espera",
      "aria-label": "Mantén presionado para grabar",
    },
    [h("span", { class: "material-symbols-outlined orb-icon", "aria-hidden": "true" }, "mic")],
  );

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
  // Push-to-talk triggers on the mic orb (feature 111)
  // -------------------------------------------------------------------------
  // pointerdown starts the capture, pointerup/pointercancel/pointerleave cut
  // it — the practice view owns the turn, so the handlers are no-ops while no
  // capture is armed (the orb is `disabled` then, and pointer events do not
  // reach disabled buttons either). `preventDefault()` on pointerdown keeps
  // the button from stealing focus, so SPACE cannot double-activate it.
  orbBtn.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handlers.onPttPress?.("pointer");
  });
  orbBtn.addEventListener("pointerup", () => handlers.onPttRelease?.("pointer"));
  orbBtn.addEventListener("pointercancel", () => handlers.onPttRelease?.("pointer"));
  orbBtn.addEventListener("pointerleave", () => handlers.onPttRelease?.("pointer"));

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
  // Orb (push-to-talk button, feature 111 — enabled only while a turn waits)
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
      // it, ANY other mode (or disable) clears it — the capture state is
      // driven through this API (press handler → practice view → here), so a
      // stale amber can never survive a phase change.
      if (m === "recording") {
        orbBtn.classList.add("recording");
      } else {
        orbBtn.classList.remove("recording");
      }
      dock.dataset.mode = m;
    },
    setOrbEnabled(enabled) {
      // Armed = the turn waits for the user's press (feature 111): the orb is
      // a live push-to-talk button. Disabled = no turn in flight, so no press
      // can ever reach it and the mic cannot start by itself.
      orbBtn.disabled = !enabled;
      // `armed` on the dock root drives the "waiting" visual state in CSS.
      dock.classList.toggle("armed", enabled);
      if (enabled) {
        orbBtn.classList.add("armed");
      } else {
        orbBtn.classList.remove("armed");
        orbBtn.classList.remove("recording");
      }
      orbBtn.title = enabled ? "Mantén presionado para grabar (o la tecla espacio)" : "A la espera";
      if (enabled && mode === "idle") micLabel.textContent = "Tu turno · mantén presionado";
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