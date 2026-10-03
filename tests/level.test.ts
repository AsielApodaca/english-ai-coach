import { test } from "node:test";
import assert from "node:assert/strict";

import {
  normalizationGain,
  measureBuffer,
  RMS_TARGET_DBFS,
  PEAK_CEILING_DBFS,
  MAX_BOOST,
} from "../public/speech/level.js";

/** Approximate float comparison (dB math has rounding). */
function near(actual: number, expected: number, eps = 1e-6): void {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `expected ${actual} ≈ ${expected} (±${eps})`,
  );
}

// ---------------------------------------------------------------------------
// normalizationGain — pure mirror of the server's normalizeWav (feature 114)
// ---------------------------------------------------------------------------

test("normalizationGain: at target level with headroom → unity gain", () => {
  near(normalizationGain({ rmsDbfs: -15, peakDbfs: -11 }), 1);
});

test("normalizationGain: a quiet signal is boosted toward the RMS target", () => {
  // −21 dBFS RMS → −15 target = +6 dB = ×1.995…; the peak (−15) still allows
  // more headroom, so the RMS target wins (stays under MAX_BOOST).
  const gain = normalizationGain({ rmsDbfs: -21, peakDbfs: -15 });
  near(gain, Math.pow(10, 6 / 20), 1e-9);
  assert.ok(gain > 1, "a quiet file must be amplified");
});

test("normalizationGain: a loud signal is attenuated to the RMS target", () => {
  // −3 dBFS RMS → −15 target = −12 dB = ×0.251188…
  const gain = normalizationGain({ rmsDbfs: -3, peakDbfs: -0.5 });
  near(gain, Math.pow(10, -12 / 20), 1e-9);
  assert.ok(gain < 1, "a loud file must only ever be attenuated");
});

test("normalizationGain: the peak ceiling blocks a boost that would clip", () => {
  // Quiet RMS (would want ×5.62) but the peak already sits at the ceiling →
  // gain is clamped to 1, so playback can NEVER clip (spec 114).
  const gain = normalizationGain({ rmsDbfs: -30, peakDbfs: -1 });
  near(gain, 1);
});

test("normalizationGain: boosts are capped at MAX_BOOST", () => {
  // Very quiet: RMS would ask for ×100 → capped.
  const gain = normalizationGain({ rmsDbfs: -60, peakDbfs: -55 });
  assert.equal(gain, MAX_BOOST);
});

test("normalizationGain: silence is never boosted", () => {
  assert.equal(normalizationGain({ rmsDbfs: -Infinity, peakDbfs: -Infinity }), 1);
  assert.equal(normalizationGain({ rmsDbfs: -90, peakDbfs: -90 }), 1);
  assert.equal(normalizationGain({ rmsDbfs: Number.NaN, peakDbfs: Number.NaN }), 1);
});

test("normalizationGain: defaults match the server constants", () => {
  assert.equal(RMS_TARGET_DBFS, -15);
  assert.equal(PEAK_CEILING_DBFS, -1);
  assert.equal(MAX_BOOST, 4);
});

// ---------------------------------------------------------------------------
// measureBuffer — pure over its `{ getChannelData }` stand-in
// ---------------------------------------------------------------------------

test("measureBuffer: reports peak and RMS in dBFS", () => {
  const buffer = {
    numberOfChannels: 1,
    getChannelData: () => Float32Array.from([0.5, -0.5, 1]),
  };
  const { peakDbfs, rmsDbfs } = measureBuffer(buffer);
  near(peakDbfs, 0, 1e-9); // peak = 1.0 → 0 dBFS
  // rms = sqrt((0.25 + 0.25 + 1) / 3) = sqrt(0.5) → −3.0103 dBFS
  near(rmsDbfs, 20 * Math.log10(Math.sqrt(0.5)), 1e-9);
});

test("measureBuffer: iterates every channel", () => {
  const calls: number[] = [];
  const buffer = {
    numberOfChannels: 2,
    getChannelData: (c: number) => {
      calls.push(c);
      return Float32Array.from([0.25]);
    },
  };
  const { peakDbfs } = measureBuffer(buffer);
  assert.deepEqual(calls, [0, 1]);
  near(peakDbfs, 20 * Math.log10(0.25), 1e-9);
});

test("measureBuffer: an empty buffer reports silence instead of NaN", () => {
  const buffer = { numberOfChannels: 1, getChannelData: () => Float32Array.from([]) };
  const { peakDbfs, rmsDbfs } = measureBuffer(buffer);
  assert.equal(peakDbfs, -Infinity);
  assert.equal(rmsDbfs, -Infinity);
});
