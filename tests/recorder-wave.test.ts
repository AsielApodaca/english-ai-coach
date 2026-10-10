import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeWAV, WaveRecorder } from "../public/speech/recorder-wave.js";

/** Decode a WAV blob into its little-endian header + raw 16-bit samples. */
async function decode(wav: Blob) {
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

test("WaveRecorder.snapshotWav: a full-copy window that never mutates the buffer (121)", async () => {
  // The recorder runs no AudioContext in Node: the buffer is fed by hand,
  // which is exactly what the live-window pump reads on the browser side.
  const recorder = new WaveRecorder();
  recorder.sampleRate = 16000;
  recorder.samples.push(new Float32Array([0.5, -0.5]), new Float32Array([0.25]));
  const before = recorder.samples.map((c) => Array.from(c));

  const snapshot = await decode(recorder.snapshotWav());
  assert.equal(recorder.samples.length, 2, "the snapshot must not touch the chunk list");
  assert.deepEqual(recorder.samples.map((c) => Array.from(c)), before, "every frame stays intact");
  assert.equal(snapshot.riff, "RIFF");
  assert.equal(snapshot.rate, 16000);
  assert.equal(snapshot.dataLen, 6, "the window carries EVERY sample captured so far");
  assert.deepEqual(snapshot.samples, [16383, -16384, 8191]);

  // The final evaluation still gets the same single full WAV from stop():
  // the snapshot left the buffer complete, so stop() encodes all 3 samples.
  const final = await decode(recorder.stop());
  assert.equal(final.dataLen, 6, "stop() after a snapshot must still yield the full take");
  assert.equal(recorder.samples.length, 0, "stop() empties the buffer as always");
});

test("WaveRecorder.snapshotWav: repeated snapshots grow with the capture (cumulative windows)", async () => {
  const recorder = new WaveRecorder();
  recorder.sampleRate = 16000;
  recorder.samples.push(new Float32Array(800));
  const first = await decode(recorder.snapshotWav());
  assert.equal(first.dataLen, 1600); // 800 samples × 2 bytes
  recorder.samples.push(new Float32Array(800));
  const second = await decode(recorder.snapshotWav());
  assert.equal(second.dataLen, 3200, "each window is the whole prefix, not a disjoint chunk");
  assert.equal(recorder.samples.length, 2, "still no mutation");
});