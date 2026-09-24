import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeWAV } from "../public/speech/recorder-wave.js";

/** Decode a WAV blob into its little-endian header + raw 16-bit samples. */
async function decode(wav) {
  const bytes = new Uint8Array(await wav.arrayBuffer());
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const riff = String.fromCharCode(...bytes.subarray(0, 4));
  const wave = String.fromCharCode(...bytes.subarray(8, 12));
  const channels = view.getUint16(22, true);
  const rate = view.getUint32(24, true);
  const bits = view.getUint16(34, true);
  const fmtTag = view.getUint16(20, true);
  const dataLen = view.getUint32(40, true);
  const riffSize = view.getUint32(4, true);
  const samples = [];
  for (let i = 44; i < dataLen + 44; i += 2) samples.push(view.getInt16(i, true));
  return { riff, wave, channels, rate, bits, fmtTag, dataLen, riffSize, samples };
}

test("encodeWAV: writes a 16 kHz mono PCM RIFF/WAVE blob", async () => {
  const w = await decode(encodeWAV(new Float32Array([0, 0.5, -0.5]), 16000));
  assert.equal(w.riff, "RIFF");
  assert.equal(w.wave, "WAVE");
  assert.equal(w.fmtTag, 1); // PCM
  assert.equal(w.channels, 1);
  assert.equal(w.rate, 16000); // whisper.cpp expects 16 kHz input
  assert.equal(w.bits, 16);
  assert.equal(w.dataLen, 6); // 3 samples × 2 bytes
  assert.equal(w.riffSize, 42); // 36 + dataLen
  // 0.5 * 0x7fff truncates to 16383; -0.5 * 0x8000 is exactly -16384.
  assert.deepEqual(w.samples, [0, 16383, -16384]);
});

test("encodeWAV: sample rate is honored from the context (native vs 16k)", async () => {
  assert.equal((await decode(encodeWAV(new Float32Array([1]), 48000))).rate, 48000);
  assert.equal((await decode(encodeWAV(new Float32Array([1]), 44100))).rate, 44100);
});

test("encodeWAV: clamps samples to the [-1, 1] PCM range", async () => {
  assert.deepEqual((await decode(encodeWAV(new Float32Array([1.4, -2, 0.25]), 16000))).samples, [32767, -32768, 8191]);
});

test("encodeWAV: empty recording still yields a valid empty WAV", async () => {
  const w = await decode(encodeWAV(new Float32Array(0), 16000));
  assert.equal(w.dataLen, 0);
  assert.equal(w.samples.length, 0);
});