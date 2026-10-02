import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildWavHeader,
  normalizeWav,
  RMS_TARGET_DBFS,
  PEAK_CEILING_DBFS,
  FADE_MS,
} from "../src/lib/piper.ts";

const FMT_MONO_16K = { sampleRate: 16000, bitsPerSample: 16, numChannels: 1 };

/** Peak allowed after normalization: the ceiling expressed in int16 counts. */
const PEAK_LIMIT = Math.ceil(32768 * Math.pow(10, PEAK_CEILING_DBFS / 20)) + 2; // +2 rounding margin

/** Wrap raw PCM16 data in a WAV header. */
function wav(pcm: Buffer, fmt = FMT_MONO_16K): Buffer {
  return Buffer.concat([buildWavHeader(pcm.length, fmt), pcm]);
}

/**
 * Cosine PCM16 samples (a speech-like periodic signal).
 * Cosine STARTS at peak amplitude on purpose: that makes the fade-in/out
 * assertions meaningful (a sine would open on a zero crossing anyway).
 */
function sinePcm({ amplitude = 32000, ms = 500, sampleRate = 16000, freq = 220 }): Buffer {
  const n = Math.round((ms / 1000) * sampleRate);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.round(amplitude * Math.cos((2 * Math.PI * freq * i) / sampleRate));
    pcm.writeInt16LE(v, i * 2);
  }
  return pcm;
}

/** Peak (abs int16) of a WAV's data region. */
function peakOf(buf: Buffer): number {
  let peak = 0;
  const start = 44;
  for (let i = start; i + 1 < buf.length; i += 2) {
    const a = Math.abs(buf.readInt16LE(i));
    if (a > peak) peak = a;
  }
  return peak;
}

/** RMS in dBFS of a WAV's data region. */
function rmsDbfs(buf: Buffer): number {
  let sum = 0;
  let count = 0;
  for (let i = 44; i + 1 < buf.length; i += 2) {
    const v = buf.readInt16LE(i);
    sum += v * v;
    count++;
  }
  if (!count) return -Infinity;
  return 20 * Math.log10(Math.sqrt(sum / count) / 32768);
}

// ---------------------------------------------------------------------------
// Level normalization (spec 114: RMS −16..−14 dBFS, peak ≤ −1 dBFS, no clip)
// ---------------------------------------------------------------------------

test("normalizeWav: brings a loud sine to the RMS target without clipping", () => {
  const out = normalizeWav(wav(sinePcm({ amplitude: 32000 })));
  assert.ok(peakOf(out) <= PEAK_LIMIT, `peak ${peakOf(out)} exceeds the ${PEAK_LIMIT} limit`);
  const rms = rmsDbfs(out);
  assert.ok(rms >= -16 && rms <= -14, `RMS ${rms.toFixed(2)} dBFS outside −16..−14`);
});

test("normalizeWav: boosts a quiet signal up to the RMS target", () => {
  const out = normalizeWav(wav(sinePcm({ amplitude: 1000 })));
  const rms = rmsDbfs(out);
  assert.ok(rms >= -16 && rms <= -14, `RMS ${rms.toFixed(2)} dBFS outside −16..−14`);
  assert.ok(peakOf(out) <= PEAK_LIMIT, "boost must never push the peak past the ceiling");
});

test("normalizeWav: a spiky (high crest) signal is peak-limited, never clipped", () => {
  // Mostly quiet noise with one near-full-scale spike: reaching the RMS
  // target would require a gain that clips the spike, so the peak ceiling wins.
  const pcm = sinePcm({ amplitude: 100, ms: 500 });
  pcm.writeInt16LE(32767, 1000);
  const out = normalizeWav(wav(pcm));
  assert.ok(peakOf(out) <= PEAK_LIMIT, `peak ${peakOf(out)} exceeds the ${PEAK_LIMIT} limit`);
  assert.ok(rmsDbfs(out) < RMS_TARGET_DBFS, "crest-limited output stays below the RMS target");
});

test("normalizeWav: input buffer is never mutated", () => {
  const input = wav(sinePcm({ amplitude: 32000 }));
  const pristine = Buffer.from(input);
  normalizeWav(input);
  assert.deepEqual(input, pristine);
});

test("normalizeWav: header, format and duration are preserved", () => {
  const input = wav(sinePcm({ amplitude: 5000 }));
  const out = normalizeWav(input);
  assert.equal(out.length, input.length, "same byte length (no re-encode)");
  assert.equal(out.readUInt32LE(24), input.readUInt32LE(24), "sample rate preserved");
  assert.equal(out.readUInt16LE(22), input.readUInt16LE(22), "channels preserved");
  assert.equal(out.readUInt16LE(34), 16, "still PCM16");
  assert.equal(out.readUInt32LE(40), input.readUInt32LE(40), "data size preserved");
});

// ---------------------------------------------------------------------------
// Fades (spec: 5–10 ms anti-click in/out)
// ---------------------------------------------------------------------------

test("normalizeWav: applies the fade-in/out (first and last samples go silent)", () => {
  const input = wav(sinePcm({ amplitude: 32000, ms: 500 }));
  const out = normalizeWav(input); // default FADE_MS
  const first = Math.abs(out.readInt16LE(44));
  const last = Math.abs(out.readInt16LE(out.length - 2));
  assert.equal(first, 0, "fade-in must silence the very first sample");
  assert.equal(last, 0, "fade-out must silence the very last sample");
  // Sanity: the middle of the file still carries the signal.
  const mid = Math.abs(out.readInt16LE(44 + Math.floor((out.length - 44) / 4) * 2));
  assert.ok(mid > 0, "the middle of the file must keep the signal");
});

test("normalizeWav: fadeMs=0 leaves the edges untouched (gain only)", () => {
  const input = wav(sinePcm({ amplitude: 1000, ms: 200 }));
  const out = normalizeWav(input, { fadeMs: 0 });
  assert.ok(Math.abs(out.readInt16LE(44)) > 0, "no fade-in with fadeMs=0");
  assert.ok(Math.abs(out.readInt16LE(out.length - 2)) > 0, "no fade-out with fadeMs=0");
});test("normalizeWav: default fade length is inside the spec's 5–10 ms window", () => {
  assert.ok(FADE_MS >= 5 && FADE_MS <= 10, `FADE_MS=${FADE_MS} outside 5–10 ms`);
  assert.ok(RMS_TARGET_DBFS >= -16 && RMS_TARGET_DBFS <= -14);
  assert.ok(PEAK_CEILING_DBFS <= -1);
});

// ---------------------------------------------------------------------------
// Defensive passthroughs
// ---------------------------------------------------------------------------

test("normalizeWav: digital silence is returned unchanged", () => {
  const input = wav(Buffer.alloc(8000 * 2)); // 0.5 s of zeroes
  const out = normalizeWav(input);
  assert.deepEqual(out, input);
  assert.ok(peakOf(out) === 0);
});

test("normalizeWav: near-silence (below the floor) is not boosted", () => {
  const pcm = Buffer.alloc(8000 * 2);
  for (let i = 0; i < 8000; i++) pcm.writeInt16LE(i % 2 ? 1 : -1, i * 2);
  const input = wav(pcm);
  const out = normalizeWav(input);
  assert.deepEqual(out, input, "noise floor must never be boosted");
});

test("normalizeWav: non-16-bit input passes through untouched", () => {
  const data = Buffer.from([0, 64, 128, 192, 255]);
  const input = Buffer.concat([buildWavHeader(data.length, { ...FMT_MONO_16K, bitsPerSample: 8 }), data]);
  const out = normalizeWav(input);
  assert.equal(out, input, "8-bit WAV must be returned as-is");
});

test("normalizeWav: stereo frames are normalized and faded per channel", () => {
  const fmt = { sampleRate: 16000, bitsPerSample: 16, numChannels: 2 };
  const frames = 8000; // 0.5 s
  const pcm = Buffer.alloc(frames * 2 * 2);
  for (let i = 0; i < frames; i++) {
    const v = Math.round(32000 * Math.cos((2 * Math.PI * 220 * i) / 16000));
    pcm.writeInt16LE(v, i * 4); // L
    pcm.writeInt16LE(v, i * 4 + 2); // R
  }
  const out = normalizeWav(wav(pcm, fmt));
  assert.equal(out.readUInt16LE(22), 2, "stays stereo");
  // First frame: both channels silenced by the fade-in.
  assert.equal(out.readInt16LE(44), 0, "left channel fade-in");
  assert.equal(out.readInt16LE(46), 0, "right channel fade-in");
  assert.ok(peakOf(out) <= PEAK_LIMIT, `peak ${peakOf(out)} exceeds the limit`);
});
