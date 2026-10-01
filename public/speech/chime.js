/**
 * Success chime (feature 110) — a short "ding" synthesized with the Web Audio
 * API: no audio assets, no network, no npm dependencies. `chimePlan()` is the
 * pure core (no AudioContext) so Node can unit-test timing, tones and gain
 * clamp; `playChime()` / `stopChime()` wrap a single lazily-created context.
 */

import { volumeFactor } from "../ui/settings/volume.js";

/** Tone shape per kind: frequencies in Hz (gentle fifth pair) + loudness. */
const KINDS = {
  pass: { frequencies: [880, 1320], gainScale: 1 },
  fail: { frequencies: [660, 990], gainScale: 0.6 },
};
/** Total length (spec 110: overhead per pass <= 300 ms) + attack ramp (ms). */
const DURATION_MS = 250;
const ATTACK_MS = 25;
/** Peak amplitude at full coach volume: gentle, never full-scale. */
const CHIME_PEAK = 0.3;

/**
 * Pure description of one chime: everything `playChime` needs, computable
 * without an AudioContext. All times are milliseconds from the chime start.
 *
 * @param {{ kind?: "pass"|"fail", volume?: number, sampleRate?: number }} [opts]
 *   `volume` is the coach volume factor from the view's `volumeSetting()`;
 *   `sampleRate` caps the tones below the Nyquist limit.
 * @returns {{ frequencies: number[], durationMs: number, gain: number,
 *             attack: { start: number, end: number },
 *             decay: { start: number, end: number } }}
 */
export function chimePlan({ kind = "pass", volume = 1, sampleRate = 48000 } = {}) {
  const shape = KINDS[kind] ?? KINDS.pass;
  const nyquist = Math.max(1, sampleRate / 2 - 1);
  return {
    frequencies: shape.frequencies.map((f) => Math.min(f, nyquist)),
    durationMs: DURATION_MS,
    gain: clampChimeVolume(volume) * CHIME_PEAK * shape.gainScale,
    attack: { start: 0, end: ATTACK_MS },
    decay: { start: ATTACK_MS, end: DURATION_MS },
  };
}

/**
 * Clamp the coach volume factor with the SAME clamp/floor the view uses:
 * `volumeSetting()` reads a percent through `volumeFactor` (10% floor — a
 * silent coach is useless), so the factor is pushed back through that exact
 * helper (x100) instead of duplicating the clamp.
 *
 * @param {number} volume - coach volume factor (0.1–1 normally)
 * @returns {number} factor clamped into [0.1, 1]
 */
function clampChimeVolume(volume) {
  return volumeFactor(volume * 100);
}

/** The AudioContext shared by every chime (created on first play). */
let audioCtx = null;
/** Chime in flight: promise settle + audio nodes (see `stopChime`). */
let active = null;

/**
 * Play the chime once and resolve when its sound has ended. Single-flight
 * (a chime already playing is stopped first), resumes a context the autoplay
 * policy left suspended, and resolves immediately when Web Audio is missing
 * or resume is refused — no caller can hang on a sound that will not play.
 *
 * @param {{ kind?: "pass"|"fail", volume?: number }} [opts]
 * @returns {Promise<void>} resolves when the chime ended or was stopped
 */
export function playChime({ kind = "pass", volume = 1 } = {}) {
  const plan = chimePlan({ kind, volume });
  stopChime();
  return new Promise((resolve) => {
    if (typeof AudioContext === "undefined") return resolve();
    let ctx;
    try {
      audioCtx ??= new AudioContext();
      ctx = audioCtx;
    } catch {
      return resolve(); // audio unavailable → play silently, never reject
    }
    const chime = { resolve, oscillators: [], gain: null };
    active = chime;
    const start = () => {
      if (active !== chime) return; // stopped while the context was resuming
      try {
        const t0 = ctx.currentTime;
        const gain = (chime.gain = ctx.createGain());
        gain.gain.setValueAtTime(0, t0 + plan.attack.start / 1000);
        gain.gain.linearRampToValueAtTime(plan.gain, t0 + plan.attack.end / 1000);
        gain.gain.linearRampToValueAtTime(0, t0 + plan.decay.end / 1000);
        gain.connect(ctx.destination);
        for (const frequency of plan.frequencies) {
          const osc = ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.value = frequency;
          osc.connect(gain);
          osc.start(t0);
          osc.stop(t0 + plan.durationMs / 1000);
          chime.oscillators.push(osc);
        }
        chime.oscillators.at(-1).onended = () => active === chime && stopChime();
      } catch {
        stopChime();
      }
    };
    if (ctx.state === "suspended") ctx.resume().then(start, () => stopChime());
    else start();
  });
}

/**
 * Stop the chime in flight (or finish the one that just ended): silence its
 * oscillators, release the graph and settle its promise so no caller waits on
 * a sound that will never end. `cancelFlow()` calls this.
 */
export function stopChime() {
  if (!active) return;
  const chime = active;
  active = null;
  for (const osc of chime.oscillators) {
    osc.onended = null;
    try {
      osc.stop();
    } catch {
      // already stopped — the disconnect below silences it
    }
    osc.disconnect();
  }
  chime.gain?.disconnect();
  chime.resolve();
}
