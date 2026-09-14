import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkPiper,
  downloadVoice,
  synthesize,
  concatWavWithPauses,
  makeSilence,
  buildWavHeader,
  DEFAULT_VOICE,
} from "../src/lib/piper.ts";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engcoach-piper-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// If piper is actually installed on this machine, the "unavailable" paths
// below are not applicable and are skipped instead of failing.
const piperInstalled = checkPiper(process.cwd()).available;

// ---------------------------------------------------------------------------
// checkPiper
// ---------------------------------------------------------------------------

test("checkPiper: reports unavailable in an empty directory", { skip: piperInstalled && "piper is installed; unavailable path not applicable" }, () => {
  const handle = checkPiper(dir);
  assert.equal(handle.available, false);
  assert.equal(handle.voiceReady, false);
  assert.equal(handle.binary, null);
  assert.equal(handle.modelPath, null);
  assert.equal(handle.voiceName, DEFAULT_VOICE);
  assert.match(handle.hint, /pipx install piper-tts/);
});

test("checkPiper: reports voiceReady when both model files exist", () => {
  const modelsDir = join(dir, "models", "piper");
  mkdirSync(modelsDir, { recursive: true });
  writeFileSync(join(modelsDir, `${DEFAULT_VOICE}.onnx`), "fake-onnx");
  writeFileSync(join(modelsDir, `${DEFAULT_VOICE}.onnx.json`), "{}");

  const handle = checkPiper(dir);
  assert.equal(handle.voiceReady, true);
  assert.equal(handle.modelPath, join(modelsDir, `${DEFAULT_VOICE}.onnx`));
  // The download hint only applies when piper is not actually installed.
  if (!piperInstalled) assert.match(handle.hint, /npm run setup -- --tts/);
});

test("checkPiper: unknown voice is reported as not ready with a hint", () => {
  const modelsDir = join(dir, "models", "piper");
  mkdirSync(modelsDir, { recursive: true });
  writeFileSync(join(modelsDir, `${DEFAULT_VOICE}.onnx`), "fake-onnx");
  writeFileSync(join(modelsDir, `${DEFAULT_VOICE}.onnx.json`), "{}");

  const handle = checkPiper(dir, "xx-unknown-voice");
  assert.equal(handle.voiceName, "xx-unknown-voice");
  assert.equal(handle.voiceReady, false);
  assert.equal(handle.modelPath, null);
  // The unsupported-voice hint only surfaces once piper is installed.
  if (piperInstalled) assert.match(handle.hint, /Unsupported/);
});

// ---------------------------------------------------------------------------
// downloadVoice
// ---------------------------------------------------------------------------

test("downloadVoice: returns existing paths without network when files are present", async () => {
  const modelsDir = join(dir, "models", "piper");
  mkdirSync(modelsDir, { recursive: true });
  const onnxPath = join(modelsDir, `${DEFAULT_VOICE}.onnx`);
  const jsonPath = join(modelsDir, `${DEFAULT_VOICE}.onnx.json`);
  writeFileSync(onnxPath, "fake-onnx");
  writeFileSync(jsonPath, "{}");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network must not be used when files already exist");
  };
  try {
    const paths = await downloadVoice(DEFAULT_VOICE, dir);
    assert.equal(paths.onnxPath, onnxPath);
    assert.equal(paths.jsonPath, jsonPath);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("downloadVoice: creates the models directory before attempting download", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network disabled in tests");
  };
  try {
    await assert.rejects(() => downloadVoice(DEFAULT_VOICE, dir), /network disabled in tests/);
    assert.ok(existsSync(join(dir, "models", "piper")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("downloadVoice: unknown voice resolves to the default voice files", async () => {
  const modelsDir = join(dir, "models", "piper");
  mkdirSync(modelsDir, { recursive: true });
  writeFileSync(join(modelsDir, `${DEFAULT_VOICE}.onnx`), "fake-onnx");
  writeFileSync(join(modelsDir, `${DEFAULT_VOICE}.onnx.json`), "{}");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network must not be used when files already exist");
  };
  try {
    const paths = await downloadVoice("xx-unknown-voice", dir);
    assert.equal(paths.onnxPath, join(modelsDir, `${DEFAULT_VOICE}.onnx`));
    assert.equal(paths.jsonPath, join(modelsDir, `${DEFAULT_VOICE}.onnx.json`));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// synthesize
// ---------------------------------------------------------------------------

test("synthesize: throws piper-unavailable when piper is not installed", { skip: piperInstalled && "piper is installed; unavailable path not applicable" }, async () => {
  await assert.rejects(() => synthesize("hello", dir), /piper-unavailable/);
});

// ---------------------------------------------------------------------------
// WAV helpers (pure logic — no piper binary required)
// ---------------------------------------------------------------------------

const MONO_16K = { sampleRate: 16000, bitsPerSample: 16, numChannels: 1 };

/** Build a minimal valid WAV buffer from raw PCM data. */
function makeTestWav(pcm: Buffer, fmt: { sampleRate: number; bitsPerSample: number; numChannels: number }): Buffer {
  return Buffer.concat([buildWavHeader(pcm.length, fmt), pcm]);
}

test("buildWavHeader: produces a valid 44-byte RIFF header", () => {
  const dataSize = 32000;
  const header = buildWavHeader(dataSize, MONO_16K);

  assert.equal(header.length, 44);
  assert.equal(header.toString("ascii", 0, 4), "RIFF");
  assert.equal(header.readUInt32LE(4), 36 + dataSize); // file size minus 8
  assert.equal(header.toString("ascii", 8, 12), "WAVE");
  assert.equal(header.toString("ascii", 12, 16), "fmt ");
  assert.equal(header.readUInt32LE(16), 16); // PCM sub-chunk size
  assert.equal(header.readUInt16LE(20), 1); // audio format: PCM
  assert.equal(header.readUInt16LE(22), 1); // mono
  assert.equal(header.readUInt32LE(24), 16000); // sample rate
  assert.equal(header.readUInt32LE(28), 16000 * 2); // byte rate
  assert.equal(header.readUInt16LE(32), 2); // block align
  assert.equal(header.readUInt16LE(34), 16); // bits per sample
  assert.equal(header.toString("ascii", 36, 40), "data");
  assert.equal(header.readUInt32LE(40), dataSize);
});

test("makeSilence: produces zeroed PCM of the requested duration", () => {
  const silence = makeSilence(1000, MONO_16K);
  // 1 s at 16 kHz mono 16-bit = 32000 data bytes + 44-byte header.
  assert.equal(silence.length, 44 + 32000);
  assert.equal(silence.toString("ascii", 0, 4), "RIFF");
  assert.equal(silence.readUInt32LE(40), 32000);
  assert.ok(silence.subarray(44).every((b) => b === 0), "silence PCM must be all zeroes");
});

test("makeSilence: stereo and fractional durations scale correctly", () => {
  const stereo = makeSilence(500, { sampleRate: 22050, bitsPerSample: 16, numChannels: 2 });
  // 0.5 s * 22050 Hz * 2 channels * 2 bytes = 44100 data bytes.
  assert.equal(stereo.length, 44 + 44100);
  assert.equal(stereo.readUInt32LE(40), 44100);
});

test("makeSilence: zero milliseconds produces a header-only buffer", () => {
  const silence = makeSilence(0, MONO_16K);
  assert.equal(silence.length, 44);
  assert.equal(silence.readUInt32LE(40), 0);
});

test("concatWavWithPauses: inserts measured silence between two clips", () => {
  const clip1 = makeTestWav(Buffer.from([1, 2, 3, 4]), MONO_16K);
  const clip2 = makeTestWav(Buffer.from([5, 6, 7, 8]), MONO_16K);
  const pauseMs = 250;
  const silenceBytes = Math.round((pauseMs / 1000) * 16000) * 2; // 8000 bytes

  const out = concatWavWithPauses([clip1, clip2], pauseMs);
  assert.equal(out.length, 44 + 4 + silenceBytes + 4);
  assert.equal(out.readUInt32LE(40), 4 + silenceBytes + 4);

  const data = out.subarray(44);
  assert.deepEqual([...data.subarray(0, 4)], [1, 2, 3, 4]);
  assert.ok(data.subarray(4, 4 + silenceBytes).every((b) => b === 0), "pause must be silent");
  assert.deepEqual([...data.subarray(4 + silenceBytes)], [5, 6, 7, 8]);
});

test("concatWavWithPauses: zero pause concatenates data back-to-back", () => {
  const clip1 = makeTestWav(Buffer.from([1, 2]), MONO_16K);
  const clip2 = makeTestWav(Buffer.from([3, 4]), MONO_16K);

  const out = concatWavWithPauses([clip1, clip2], 0);
  assert.equal(out.length, 44 + 4);
  assert.deepEqual([...out.subarray(44)], [1, 2, 3, 4]);
});

test("concatWavWithPauses: single clip without pause is returned unchanged", () => {
  const clip = makeTestWav(Buffer.from([9, 9]), MONO_16K);
  const out = concatWavWithPauses([clip], 0);
  assert.equal(out, clip); // same reference, no copy
});

test("concatWavWithPauses: three clips get two pauses", () => {
  const clips = [1, 2, 3].map((n) => makeTestWav(Buffer.from([n]), MONO_16K));
  const pauseMs = 100;
  const silenceBytes = Math.round((pauseMs / 1000) * 16000) * 2;

  const out = concatWavWithPauses(clips, pauseMs);
  assert.equal(out.length, 44 + 3 + 2 * silenceBytes);

  const data = out.subarray(44);
  // Layout: [1] + silence + [2] + silence + [3]
  assert.equal(data[0], 1);
  assert.equal(data[1 + silenceBytes], 2);
  assert.equal(data[2 + 2 * silenceBytes], 3);
  assert.ok(data.subarray(1, 1 + silenceBytes).every((b) => b === 0));
  assert.ok(data.subarray(2 + silenceBytes, 2 + 2 * silenceBytes).every((b) => b === 0));
});

test("concatWavWithPauses: result header reflects the combined format", () => {
  const clip1 = makeTestWav(Buffer.from([1, 2, 3, 4]), MONO_16K);
  const clip2 = makeTestWav(Buffer.from([5, 6, 7, 8]), MONO_16K);

  const out = concatWavWithPauses([clip1, clip2], 100);
  assert.equal(out.toString("ascii", 0, 4), "RIFF");
  assert.equal(out.toString("ascii", 8, 12), "WAVE");
  assert.equal(out.readUInt16LE(22), 1); // mono
  assert.equal(out.readUInt32LE(24), 16000); // sample rate
  assert.equal(out.readUInt16LE(34), 16); // bits per sample
  assert.equal(out.readUInt32LE(40), out.length - 44); // data chunk size
});

test("concatWavWithPauses: throws on empty input", () => {
  assert.throws(() => concatWavWithPauses([], 100), /No WAV buffers/);
});