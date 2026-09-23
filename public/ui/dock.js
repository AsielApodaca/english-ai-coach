/**
 * Dock orchestrator: orb (push-to-talk), waveform, tempo selector, dB monitor
 * and microphone state.
 *
 * In feature 101 the orb is a visual stub: pressing it shows the concentric
 * rings but does not start recording (feature 105 wires real capture).
 */

import { createWaveform } from "./waveform.js";

/**
 * Initialize the floating audio dock.
 *
 * @param {import("./store.js").ShellState} store - shell store singleton
 * @param {HTMLElement} root - the `#dock` element
 * @returns {{ destroy: () => void }}
 */
export function initDock(store, root) {
  const orb = root.querySelector("#orb");
  const waveformCanvas = root.querySelector("#waveform");
  const tempoButtons = [...root.querySelectorAll(".tempo-btn")];
  const dbEl = root.querySelector("#db-value");
  const micStateEl = root.querySelector("#mic-state");

  // Orb — idle stub: rings while pressed, no functional recording in 101.
  orb.addEventListener("pointerdown", () => orb.classList.add("pressed"));
  const release = () => orb.classList.remove("pressed");
  orb.addEventListener("pointerup", release);
  orb.addEventListener("pointerleave", release);
  orb.addEventListener("pointercancel", release);

  // Tempo selector → store.
  for (const btn of tempoButtons) {
    btn.addEventListener("click", () => {
      store.set({ tempo: Number(btn.dataset.tempo) });
      for (const b of tempoButtons) b.classList.toggle("active", b === btn);
    });
  }

  // Waveform + dB monitor (level is reported every frame as 0..1).
  const waveform = createWaveform(waveformCanvas, store, (level) => {
    const db = level <= 0.001 ? -Infinity : 20 * Math.log10(level);
    dbEl.textContent = Number.isFinite(db) ? `${db.toFixed(1)} dB` : "–∞ dB";
  });

  // Mic state from the store.
  const unsubscribe = store.subscribe((s) => {
    micStateEl.textContent = s.micActive ? "recording" : "idle";
    micStateEl.classList.toggle("recording", s.micActive);
    orb.classList.toggle("recording", s.micActive);
  });

  return {
    destroy() {
      unsubscribe();
      waveform.destroy();
    },
  };
}