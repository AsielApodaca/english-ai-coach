/**
 * Attempt chime (feature 110) — a short synthesized cue played with the Web
 * Audio API: no audio assets, no network, no npm dependencies. Two kinds:
 * `pass` (the "correcto" ding) and `fail` (a descending pair, feature 120,
 * that replaced the spoken "Almost there … percent" line). `chimePlan()` is
 * the pure core (no AudioContext) so Node can unit-test timing, tones and gain
 * clamp; `playChime()` / `stopChime()` wrap a single lazily-created context.
 */

import { volumeFactor } from "../ui/settings/volume.js";

/**
 * Tone shape per kind. `notes` are the schedule (a note = one oscillator with
 * its OWN attack/decay envelope, so notes can be simultaneous or sequential);
 * `noteMs` is that envelope length and `gainScale` the loudness relative to
 * the pass cue — the fail cue is deliberately NOT quieter: it must cut through
 * the user's own replay right before it. A kind's total length (last `atMs` +
 * `noteMs`) must stay within the 300 ms budget of spec 110 — asserted in
 * `tests/chime.test.ts`.
 */
const KINDS = {
  pass: { notes: [{ frequency: 880, atMs: 0 }, { frequency: 1320, atMs: 0 }], noteMs: 250, gainScale: 1 },
  // Descending C5 → F4 with a 20 ms gap: reads as "incorrecto", unlike the
  // rising fifth of `pass`. 523/349 Hz stay above the laptop-speaker rolloff.
  fail: { notes: [{ frequency: 523, atMs: 0 }, { frequency: 349, atMs: 150 }], noteMs: 130, gainScale: 1 },
};
/** Attack ramp of every note (ms). Note length lives in `KINDS[*].noteMs`. */
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
 *             decay: { start: number, end: number },
 *             notes: Array<{ frequency: number, startMs: number, gain: number }> }}
 *   `attack`/`decay` are RELATIVE to a note's own start; `notes[].startMs`
 *   schedules each one inside the chime.
 */
export function chimePlan({ kind = "pass", volume = 1, sampleRate = 48000 } = {}) {
  const shape = KINDS[kind] ?? KINDS.pass;
  const nyquist = Math.max(1, sampleRate / 2 - 1);
  const gain = clampChimeVolume(volume) * CHIME_PEAK * shape.gainScale;
  const lastStartMs = Math.max(...shape.notes.map((note) => note.atMs));
  const durationMs = lastStartMs + shape.noteMs;
  return {
    frequencies: shape.notes.map((note) => Math.min(note.frequency, nyquist)),
    durationMs,
    gain,
    attack: { start: 0, end: ATTACK_MS },
    decay: { start: ATTACK_MS, end: shape.noteMs },
    notes: shape.notes.map((note) => ({
      frequency: Math.min(note.frequency, nyquist),
      startMs: note.atMs,
      gain,
    })),
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
      // A context the page limit evicted is `closed`: `??=` would keep handing
      // out a dead handle (createGain throws → silence forever), so drop it.
      if (audioCtx?.state === "closed") audioCtx = null;
      audioCtx ??= new AudioContext();
      ctx = audioCtx;
    } catch {
      return resolve(); // audio unavailable → play silently, never reject
    }
    const chime = { resolve, oscillators: [], gains: [] };
    active = chime;
    const start = () => {
      if (active !== chime) return; // stopped while the context was resuming
      try {
        const base = ctx.currentTime;
        // One gain node per note: each carries its own envelope, which is what
        // lets `fail` place a second note after the first instead of under it.
        for (const note of plan.notes) {
          const t0 = base + note.startMs / 1000;
          const gain = ctx.createGain();
          gain.gain.setValueAtTime(0, t0 + plan.attack.start / 1000);
          gain.gain.linearRampToValueAtTime(note.gain, t0 + plan.attack.end / 1000);
          gain.gain.linearRampToValueAtTime(0, t0 + plan.decay.end / 1000);
          gain.connect(ctx.destination);
          const osc = ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.value = note.frequency;
          osc.connect(gain);
          osc.start(t0);
          osc.stop(t0 + plan.decay.end / 1000);
          chime.oscillators.push(osc);
          chime.gains.push(gain);
        }
        // Notes are scheduled in order, so the last oscillator ends last.
        chime.oscillators.at(-1).onended = () => active === chime && stopChime();
      } catch (err) {
        console.warn("[chime] could not play:", err);
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
  for (const gain of chime.gains) gain.disconnect();
  chime.resolve();
}
