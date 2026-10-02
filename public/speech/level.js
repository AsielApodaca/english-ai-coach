/**
 * Client-side level normalization for server audio (feature 114).
 *
 * The server normalizes the Piper WAV (RMS target + peak ceiling + fades).
 * edge-tts serves MP3, which the server cannot level-adjust without an MP3
 * encoder (accepted codec limitation, spec 114) — so when the active engine
 * is `edge-tts`, THIS module measures the decoded blob and applies the same
 * gain through a Web Audio gain node, keeping both engines at a consistent
 * perceived loudness.
 *
 * Design notes:
 *   - Pure functions (`normalizationGain`, `measureBuffer`) mirror the server
 *     constants (RMS −15 dBFS, peak ceiling −1 dBFS) and are unit-testable
 *     in Node without a DOM.
 *   - Attenuation (gain ≤ 1) needs no Web Audio: it folds into `audio.volume`.
 *     Only BOOSTS go through a gain node (the element cannot amplify).
 *   - Everything is defensive: any failure (no AudioContext, decode error,
 *     suspended context without a user gesture) returns `null` and the caller
 *     plays the element plainly — audio must never go silent because of a
 *     normalization attempt.
 *   - MP3 edge fades are not applied (would need a time-scheduled gain
 *     envelope); MP3 encoder padding already avoids hard clicks.
 */

/** RMS target of the normalized output (dBFS) — same as the server. */
export const RMS_TARGET_DBFS = -15;

/** Peak ceiling (dBFS) — same as the server. */
export const PEAK_CEILING_DBFS = -1;

/** Boosts are capped so a near-silent file cannot be amplified into noise. */
export const MAX_BOOST = 4;

/** Below this RMS the file counts as silence and is never boosted. */
const SILENCE_FLOOR_DBFS = -60;

/** Convert a linear amplitude (0..1) to dBFS; silence maps to −Infinity. */
function toDbfs(linear) {
  return linear > 0 ? 20 * Math.log10(linear) : -Infinity;
}

/**
 * Compute the playback gain for measured levels — pure, mirrors
 * `normalizeWav` on the server: reach the RMS target but never past the
 * peak ceiling, capped at {@link MAX_BOOST} and never boosting silence.
 *
 * @param {{ rmsDbfs: number, peakDbfs: number }} stats - measured levels.
 * @param {{ targetDbfs?: number, ceilingDbfs?: number, maxBoost?: number }} [opts]
 * @returns {number} linear gain (1 = leave as-is).
 */
export function normalizationGain(stats, opts = {}) {
  const target = opts.targetDbfs ?? RMS_TARGET_DBFS;
  const ceiling = opts.ceilingDbfs ?? PEAK_CEILING_DBFS;
  const maxBoost = opts.maxBoost ?? MAX_BOOST;
  if (!Number.isFinite(stats.rmsDbfs) || stats.rmsDbfs < SILENCE_FLOOR_DBFS) return 1;
  const gainRms = Math.pow(10, (target - stats.rmsDbfs) / 20);
  const gainPeak = Number.isFinite(stats.peakDbfs)
    ? Math.pow(10, (ceiling - stats.peakDbfs) / 20)
    : maxBoost;
  return Math.min(gainRms, gainPeak, maxBoost);
}

/**
 * Measure peak + RMS (dBFS) of a decoded audio buffer. Pure over its inputs,
 * so tests can pass any `{ numberOfChannels, getChannelData }` stand-in.
 *
 * @param {{ numberOfChannels: number, getChannelData: (c: number) => Float32Array }} buffer
 * @returns {{ peakDbfs: number, rmsDbfs: number }}
 */
export function measureBuffer(buffer) {
  let peak = 0;
  let sum = 0;
  let n = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
      sum += v * v;
      n++;
    }
  }
  const rms = n > 0 ? Math.sqrt(sum / n) : 0;
  return { peakDbfs: toDbfs(peak), rmsDbfs: toDbfs(rms) };
}

/**
 * Prepare `audio` (about to play `blob`) with normalized levels.
 *
 * Returns a controller carrying:
 *   - `durationMs` — the decoded duration (the karaoke uses it for the word
 *     highlight, saving a second decode), or 0 when unknown;
 *   - `setVolume(v)` — apply the USER volume (0–1) on top of the fixed
 *     normalization gain, live;
 *   - `dispose()` — release the audio graph (safe to call twice).
 *
 * Returns `null` when normalization is impossible (no AudioContext / decode
 * failure) — the caller then falls back to `audio.volume = v`.
 *
 * @param {HTMLAudioElement} audio - the element that will play the blob.
 * @param {Blob} blob - the audio bytes about to be played.
 * @returns {Promise<{durationMs: number, setVolume: (v: number) => void, dispose: () => void}|null>}
 */
export async function tryNormalizeElement(audio, blob) {
  let ctx = null;
  try {
    const Ctx = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    if (!Ctx) return null;

    // Decode for measurement + duration (decodeAudioData detaches the
    // ArrayBuffer, hence the copy).
    ctx = new Ctx();
    const bytes = await blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(bytes.slice(0));
    const durationMs = (decoded.duration || 0) * 1000;
    const gain = normalizationGain(measureBuffer(decoded));

    // Attenuation / unity folds into the element — no Web Audio needed.
    if (gain <= 1.0001) {
      ctx.close();
      ctx = null;
      let userVolume = 1;
      audio.volume = Math.max(0, Math.min(1, gain));
      const ctl = {
        durationMs,
        setVolume(v) {
          userVolume = Math.max(0, Math.min(1, v));
          audio.volume = Math.max(0, Math.min(1, gain * userVolume));
        },
        dispose() {},
      };
      audio.__engcoachNorm = ctl;
      return ctl;
    }

    // Boost: route the element through a gain node. A context that cannot
    // start (no user gesture yet) would silence the element — bail out to
    // the plain path instead (unboosted, but audible).
    await ctx.resume();
    if (ctx.state !== "running") {
      ctx.close();
      ctx = null;
      return null;
    }
    const source = ctx.createMediaElementSource(audio);
    const node = ctx.createGain();
    node.gain.value = gain;
    source.connect(node);
    node.connect(ctx.destination);
    audio.volume = 1; // the gain node owns the level from here on

    let userVolume = 1;
    let disposed = false;
    const ctl = {
      durationMs,
      setVolume(v) {
        userVolume = Math.max(0, Math.min(1, v));
        if (!disposed) node.gain.value = gain * userVolume;
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        try {
          source.disconnect();
          node.disconnect();
        } catch {
          /* already torn down */
        }
        try {
          ctx.close();
        } catch {
          /* already closed */
        }
      },
    };
    audio.__engcoachNorm = ctl;
    return ctl;
  } catch {
    if (ctx) {
      try {
        ctx.close();
      } catch {
        /* ignore */
      }
    }
    return null;
  }
}

/**
 * Apply the user volume (0–1) to a coach audio element, honoring the
 * normalization controller attached by {@link tryNormalizeElement} when the
 * element has one. This is what the live volume slider calls.
 *
 * @param {HTMLAudioElement} audio
 * @param {number} volume
 */
export function setElementVolume(audio, volume) {
  const v = Number(volume);
  if (!Number.isFinite(v)) return;
  const vol = Math.max(0, Math.min(1, v));
  const ctl = audio.__engcoachNorm;
  if (ctl) ctl.setVolume(vol);
  else audio.volume = vol;
}

/**
 * Release the normalization graph of a finished/stopped element (no-op for
 * plain elements). The element must not be played again afterwards.
 *
 * @param {HTMLAudioElement|null|undefined} audio
 */
export function releaseElement(audio) {
  const ctl = audio?.__engcoachNorm;
  if (!ctl) return;
  ctl.dispose();
  try {
    delete audio.__engcoachNorm;
  } catch {
    audio.__engcoachNorm = null;
  }
}
