/**
 * Piper TTS — local neural text-to-speech engine.
 *
 * Wraps the `piper` CLI binary (installed via `pipx install piper-tts`).
 * Piper reads the text to speak from **stdin** (it has no `--text` flag).
 * Models (ONNX + JSON) are downloaded from the Rhasspy Piper voices repo on
 * HuggingFace and cached under `models/piper/` inside the project root.
 *
 * Follows the same structural pattern as {@link whisper.ts}.
 */

import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { renameSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default voice (Amy, medium quality — ~60 MB total). */
export const DEFAULT_VOICE = "en_US-amy-medium";

const HF_BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0";

/** Voice definitions: HF repo subdir plus the two file names per voice. */
const VOICE_FILES: Record<string, { subdir: string; onnx: string; json: string }> = {
  [DEFAULT_VOICE]: {
    subdir: "en/en_US/amy/medium",
    onnx: "en_US-amy-medium.onnx",
    json: "en_US-amy-medium.onnx.json",
  },
  "en_US-amy-low": {
    subdir: "en/en_US/amy/low",
    onnx: "en_US-amy-low.onnx",
    json: "en_US-amy-low.onnx.json",
  },
  "en_US-ryan-medium": {
    subdir: "en/en_US/ryan/medium",
    onnx: "en_US-ryan-medium.onnx",
    json: "en_US-ryan-medium.onnx.json",
  },
};

/** Voices that are known and can be synthesized/downloaded. */
export const SUPPORTED_VOICES = Object.freeze(Object.keys(VOICE_FILES));

/**
 * True when the ONNX + JSON model files of `voice` exist locally (feature 114).
 *
 * Unlike {@link checkPiper} this is a pure file check — no `which` subprocess —
 * so the TTS route can resolve the effective voice on every request without
 * paying a process spawn per candidate voice.
 */
export function isVoiceReady(baseDir: string, voice: string): boolean {
  const info = VOICE_FILES[voice];
  if (!info) return false;
  const modelsDir = join(baseDir, "models", "piper");
  return existsSync(join(modelsDir, info.onnx)) && existsSync(join(modelsDir, info.json));
}

// ---------------------------------------------------------------------------
// Binary detection
// ---------------------------------------------------------------------------

/** Try to locate the `piper` binary on PATH and common install directories. */
function findBinary(): string | null {
  try {
    const found = execFileSync("which", ["piper"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {
    // not on PATH
  }
  // Fallback: common pipx / Homebrew locations on macOS
  const home = process.env.HOME ?? "";
  const extras = [
    join(home, ".local/bin/piper"),
    "/opt/homebrew/bin/piper",
    "/usr/local/bin/piper",
  ];
  for (const p of extras) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Status of the Piper installation. */
export interface PiperHandle {
  /** True when the `piper` binary was found on PATH. */
  available: boolean;
  /** Absolute path to the binary, or null. */
  binary: string | null;
  /** Voice identifier being checked (e.g. `en_US-amy-medium`). */
  voiceName: string;
  /** True when both .onnx and .json model files exist. */
  voiceReady: boolean;
  /** Absolute path to the .onnx model file, or null. */
  modelPath: string | null;
  /** Human-readable hint about what is missing (if anything). */
  hint: string;
}

export interface SynthesizeOptions {
  /** Piper `--length-scale` — controls speaking rate. Default ≈ 1 (normal). */
  lengthScale?: number;
  /** Milliseconds of silence to append after the spoken text. */
  pauseAfterMs?: number;
  /** Voice to use (must be in {@link SUPPORTED_VOICES}). Defaults to {@link DEFAULT_VOICE}. */
  voice?: string;
}

// ---------------------------------------------------------------------------
// checkPiper
// ---------------------------------------------------------------------------

/**
 * Check if Piper is installed and whether the requested voice model exists.
 * An unsupported voice reports `voiceReady: false` with a hint instead of
 * silently falling back to the default files.
 */
export function checkPiper(baseDir: string, voice = DEFAULT_VOICE): PiperHandle {
  const binary = findBinary();
  const voiceInfo = VOICE_FILES[voice];
  const supported = Boolean(voiceInfo);
  const modelsDir = join(baseDir, "models", "piper");
  const onnxPath = voiceInfo ? join(modelsDir, voiceInfo.onnx) : null;
  const jsonPath = voiceInfo ? join(modelsDir, voiceInfo.json) : null;
  const voiceReady = supported && existsSync(onnxPath!) && existsSync(jsonPath!);

  let hint = "";
  if (!binary) {
    hint = 'Piper not found. Install with: pipx install piper-tts (or run "npm run setup -- --tts").';
  } else if (!supported) {
    hint = `Unsupported Piper voice "${voice}". Supported voices: ${SUPPORTED_VOICES.join(", ")}.`;
  } else if (!voiceReady) {
    hint = `Run "npm run setup -- --tts" to download the ${voice} voice model.`;
  }

  return {
    available: binary !== null,
    binary,
    voiceName: voice,
    voiceReady,
    modelPath: voiceReady ? onnxPath : null,
    hint,
  };
}

// ---------------------------------------------------------------------------
// downloadVoice
// ---------------------------------------------------------------------------

/**
 * Download the ONNX model + JSON config for the given voice from HuggingFace.
 * Returns the absolute paths to the downloaded files.
 * Unknown voices fall back to {@link DEFAULT_VOICE}.
 */
export async function downloadVoice(
  voice: string,
  baseDir: string,
): Promise<{ onnxPath: string; jsonPath: string }> {
  const info = VOICE_FILES[voice] ?? VOICE_FILES[DEFAULT_VOICE];
  const modelsDir = join(baseDir, "models", "piper");
  mkdirSync(modelsDir, { recursive: true });

  const onnxPath = join(modelsDir, info.onnx);
  const jsonPath = join(modelsDir, info.json);

  // Skip download if both files already exist.
  if (existsSync(onnxPath) && existsSync(jsonPath)) {
    return { onnxPath, jsonPath };
  }

  async function downloadFile(url: string, target: string): Promise<void> {
    if (existsSync(target)) return;
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      throw new Error(`Failed to download ${url}: HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const tmp = `${target}.downtmp`;
    writeFileSync(tmp, buf);
    renameSync(tmp, target);
  }

  await downloadFile(`${HF_BASE}/${info.subdir}/${info.onnx}`, onnxPath);
  await downloadFile(`${HF_BASE}/${info.subdir}/${info.json}`, jsonPath);

  return { onnxPath, jsonPath };
}

// ---------------------------------------------------------------------------
// WAV helpers
// ---------------------------------------------------------------------------

/**
 * Concatenate multiple WAV files (must share the same format: sample rate,
 * bit depth, channels) inserting silence between and after them.
 *
 * @param buffers - the clips to glue, in order.
 * @param pauseMs - silence BETWEEN adjacent clips: a single value applied to
 *   every boundary, or one value per boundary (length `buffers.length - 1`;
 *   missing entries count as 0). Feature 114 uses the array form so a comma
 *   gets a shorter pause than a full stop.
 * @param trailingMs - silence appended AFTER the last clip (the long
 *   handover beat before the learner speaks; feature 114).
 * @returns a single WAV buffer.
 */
export function concatWavWithPauses(buffers: Buffer[], pauseMs: number | number[], trailingMs = 0): Buffer {
  if (buffers.length === 0) {
    throw new Error("No WAV buffers to concatenate");
  }
  if (buffers.length === 1 && trailingMs <= 0 && (typeof pauseMs !== "number" || pauseMs <= 0)) {
    return buffers[0];
  }

  // Read format info from the first WAV header.
  const fmt = readWavFormat(buffers[0]);

  // Resolve the between-clause pauses (array wins, missing entries are 0).
  const between: number[] = buffers.slice(1).map((_, i) =>
    Array.isArray(pauseMs) ? pauseMs[i] ?? 0 : pauseMs,
  );

  // Build a list of data-only chunks.
  const chunks: Buffer[] = [];
  for (let i = 0; i < buffers.length; i++) {
    if (i > 0 && between[i - 1] > 0) {
      // Strip the silence's own WAV header — only raw PCM belongs in the data region.
      chunks.push(extractWavData(makeSilence(between[i - 1], fmt)));
    }
    chunks.push(extractWavData(buffers[i]));
  }
  if (trailingMs > 0) {
    chunks.push(extractWavData(makeSilence(trailingMs, fmt)));
  }

  // Calculate total PCM data size.
  let totalDataSize = 0;
  for (const chunk of chunks) totalDataSize += chunk.length;

  // Build the final WAV file: 44-byte header + PCM data.
  const header = buildWavHeader(totalDataSize, fmt);
  const parts = [header, ...chunks];
  return Buffer.concat(parts);
}

/** Extract relevant format fields from a WAV header. */
function readWavFormat(buf: Buffer): {
  sampleRate: number;
  bitsPerSample: number;
  numChannels: number;
  dataOffset: number;
} {
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  const numChannels = buf.readUInt16LE(22);

  // Locate the "data" sub-chunk (may appear after "fmt " and optional extra chunks).
  let dataOffset = 44; // standard location
  const maxScan = Math.min(buf.length, 128);
  for (let i = 36; i < maxScan - 4; i++) {
    if (buf[i] === 0x64 && buf[i + 1] === 0x61 && buf[i + 2] === 0x74 && buf[i + 3] === 0x61) {
      // "data"
      dataOffset = i + 8; // skip "data" (4) + chunk-size (4)
      break;
    }
  }

  return { sampleRate, bitsPerSample, numChannels, dataOffset };
}

/** Strip the WAV header and return only the raw PCM data. */
function extractWavData(buf: Buffer): Buffer {
  const { dataOffset } = readWavFormat(buf);
  return buf.subarray(dataOffset);
}

/**
 * Create a WAV buffer containing `ms` milliseconds of digital silence.
 * Assumes 16-bit linear PCM (silence = 0x00), which is what Piper emits.
 */
export function makeSilence(ms: number, fmt: { sampleRate: number; bitsPerSample: number; numChannels: number }): Buffer {
  const numSamples = Math.round((ms / 1000) * fmt.sampleRate * fmt.numChannels);
  const dataBytes = numSamples * (fmt.bitsPerSample / 8);
  const pcm = Buffer.alloc(dataBytes, 0); // PCM16 silence = zeroes
  const header = buildWavHeader(dataBytes, fmt);
  return Buffer.concat([header, pcm]);
}

/** Build a minimal 44-byte WAV/RIFF header for PCM16 audio. */
export function buildWavHeader(dataSize: number, fmt: { sampleRate: number; bitsPerSample: number; numChannels: number }): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = fmt.sampleRate * fmt.numChannels * (fmt.bitsPerSample / 8);
  const blockAlign = fmt.numChannels * (fmt.bitsPerSample / 8);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4); // file size minus 8
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16); // sub-chunk size (PCM = 16)
  header.writeUInt16LE(1, 20); // audio format: 1 = PCM
  header.writeUInt16LE(fmt.numChannels, 22);
  header.writeUInt32LE(fmt.sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(fmt.bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return header;
}

// ---------------------------------------------------------------------------
// Level normalization + anti-click fades (feature 114)
// ---------------------------------------------------------------------------

/** RMS target of the normalized output (spec: −16 to −14 dBFS). */
export const RMS_TARGET_DBFS = -15;

/** Hard peak ceiling so the served WAV can never clip (spec: ≤ −1 dBFS). */
export const PEAK_CEILING_DBFS = -1;

/** Fade in/out length per file (spec: 5–10 ms) — kills start/end pops. */
export const FADE_MS = 8;

/** Below this RMS the buffer counts as silence and is returned untouched. */
const SILENCE_FLOOR_DBFS = -60;

export interface NormalizeWavOptions {
  /** RMS level to normalize toward (dBFS). Default {@link RMS_TARGET_DBFS}. */
  rmsTargetDbfs?: number;
  /** Peak ceiling (dBFS); the applied gain never exceeds it. Default −1. */
  peakCeilingDbfs?: number;
  /** Fade in/out length in ms; 0 disables fades. Default {@link FADE_MS}. */
  fadeMs?: number;
}

/**
 * Normalize a PCM16 WAV buffer: level (RMS toward the target, clamped so the
 * peak stays under the ceiling → no clipping) plus a linear fade in/out so
 * the file never starts or ends on a hard sample edge (clicks/pops).
 *
 * Piper's raw output measured −0.00 dBFS peak with clipped samples (feature
 * 114 diagnosis) — this is the server-side cleanup that fixes it. Non-16-bit
 * or silent buffers are returned unchanged (defensive: Piper always emits
 * PCM16 @ 22.05 kHz).
 *
 * @param wav - the WAV file to clean (header + PCM16 data).
 * @param opts - optional targets (see {@link NormalizeWavOptions}).
 * @returns a new buffer with the same format/duration, cleaned.
 */
export function normalizeWav(wav: Buffer, opts: NormalizeWavOptions = {}): Buffer {
  const rmsTargetDbfs = opts.rmsTargetDbfs ?? RMS_TARGET_DBFS;
  const peakCeilingDbfs = opts.peakCeilingDbfs ?? PEAK_CEILING_DBFS;
  const fadeMs = opts.fadeMs ?? FADE_MS;

  const fmt = readWavFormat(wav);
  if (fmt.bitsPerSample !== 16 || fmt.numChannels < 1) return wav;

  // Clamp the declared data size to what is actually in the buffer.
  const declared = wav.readUInt32LE(fmt.dataOffset - 4);
  const dataSize = Math.max(0, Math.min(declared, wav.length - fmt.dataOffset));
  if (dataSize < 4) return wav;

  const out = Buffer.from(wav); // never mutate the caller's buffer
  const pcm = out.subarray(fmt.dataOffset, fmt.dataOffset + dataSize);
  const totalSamples = pcm.length >> 1;

  // --- measure peak + RMS ---
  let peakAbs = 0;
  let sumSquares = 0;
  for (let s = 0; s < totalSamples; s++) {
    const v = pcm.readInt16LE(s * 2);
    const a = v < 0 ? -v : v;
    if (a > peakAbs) peakAbs = a;
    sumSquares += v * v;
  }
  if (peakAbs === 0) return wav; // digital silence: nothing to clean

  const peakLin = peakAbs / 32768;
  const rmsLin = Math.sqrt(sumSquares / totalSamples) / 32768;
  const rmsDb = 20 * Math.log10(rmsLin);
  if (rmsDb < SILENCE_FLOOR_DBFS) return wav; // near-silence: don't boost noise

  // Gain: reach the RMS target, but never past the peak ceiling (the smaller
  // factor always wins → loud files are attenuated, quiet ones only boosted
  // while the peak stays ≤ ceiling, so the result can never clip).
  const gainRms = Math.pow(10, (rmsTargetDbfs - rmsDb) / 20);
  const gainPeak = Math.pow(10, (peakCeilingDbfs - 20 * Math.log10(peakLin)) / 20);
  const gain = Math.min(gainRms, gainPeak);

  // --- apply gain + fades per frame (interleaved channels) ---
  const channels = fmt.numChannels;
  const totalFrames = Math.floor(totalSamples / channels);
  const fadeFrames =
    fadeMs > 0 ? Math.min(Math.round((fadeMs / 1000) * fmt.sampleRate), totalFrames) : 0;

  for (let f = 0; f < totalFrames; f++) {
    let factor = gain;
    if (fadeFrames > 0 && f < fadeFrames) factor *= f / fadeFrames;
    if (fadeFrames > 0 && f >= totalFrames - fadeFrames) {
      factor *= (totalFrames - 1 - f) / fadeFrames;
    }
    if (factor === 1) continue;
    for (let c = 0; c < channels; c++) {
      const idx = f * channels + c;
      let v = pcm.readInt16LE(idx * 2) * factor;
      if (v > 32767) v = 32767; // defensive clamp (gain ≤ ceiling ⇒ unreachable)
      else if (v < -32768) v = -32768;
      else if (v >= -0.5 && v <= 0.5) v = 0;
      pcm.writeInt16LE(Math.round(v), idx * 2);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// synthesize
// ---------------------------------------------------------------------------

/** Build the CLI argument list for the `piper` subprocess. */
function buildArgs(
  modelPath: string,
  outPath: string,
  opts: SynthesizeOptions,
): string[] {
  const args = ["--model", modelPath, "--output_file", outPath];
  if (opts.lengthScale != null) {
    args.push("--length-scale", String(opts.lengthScale));
  }
  return args;
}

/**
 * Synthesize text to a WAV buffer using the Piper CLI.
 *
 * Piper has no `--text` flag: it reads the text from **stdin**. The command
 * `piper --model <voice.onnx> --output_file <tmp.wav>` is spawned with the
 * text piped in; the resulting file is read and returned as a buffer. Temp
 * files are cleaned up automatically.
 *
 * @param text  The text to speak (must be ≤ 1000 characters).
 * @param baseDir  Project root — used to resolve model paths and temp dir.
 * @param opts  Optional: `lengthScale` (Piper speed factor), `pauseAfterMs`
 *              (silence appended after the speech).
 */
export async function synthesize(
  text: string,
  baseDir: string,
  opts: SynthesizeOptions = {},
): Promise<Buffer> {
  const piper = checkPiper(baseDir, opts.voice ?? DEFAULT_VOICE);
  if (!piper.available) throw new Error("piper-unavailable: " + piper.hint);
  if (!piper.modelPath) throw new Error("piper-voice-missing: " + piper.hint);

  const tmpDir = join(baseDir, "data", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const tmpWav = join(tmpDir, `piper-${randomUUID()}.wav`);

  try {
    const args = buildArgs(piper.modelPath, tmpWav, opts);
    const res = spawnSync(piper.binary!, args, {
      input: text, // piper reads the speech text from stdin
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (res.error) throw new Error(`piper failed to start: ${res.error.message}`);
    if (res.status !== 0) throw new Error(`piper exited ${res.status}: ${(res.stderr ?? "").slice(0, 500)}`);

    if (!existsSync(tmpWav)) {
      throw new Error("piper produced no output file");
    }

    let wav = readFileSync(tmpWav);

    // If the caller requested trailing silence, append it now.
    if (opts.pauseAfterMs && opts.pauseAfterMs > 0) {
      const fmt = readWavFormat(wav);
      const silence = makeSilence(opts.pauseAfterMs, fmt);
      const data = extractWavData(wav);
      const silenceData = extractWavData(silence);
      const totalSize = data.length + silenceData.length;
      const header = buildWavHeader(totalSize, fmt);
      wav = Buffer.concat([header, data, silenceData]);
    }

    return wav;
  } finally {
    rmSync(tmpWav, { force: true });
  }
}

/**
 * Synthesize multiple segments into a single WAV with measured silence
 * between them (feature 114: human-style clause pauses). Useful for
 * "Repeat after me… [pause] …fragment" flows where the browser should receive
 * one audio file, not a sequence.
 *
 * Each segment is level-normalized and faded ({@link normalizeWav}) BEFORE
 * concatenation, so every clause sits at the target level and the clip
 * edges inside the pauses cannot click.
 *
 * @param segments  Texts to speak, in order (each ≤ 1000 chars).
 * @param baseDir   Project root.
 * @param opts      `pausesAfterMs[i]` = silence AFTER segment i (preferred,
 *                  feature 114); `pauseBetweenMs` = one value for every
 *                  boundary (legacy); `pauseAfterMs` = trailing silence;
 *                  `lengthScale` controls the speaking rate; `voice`
 *                  selects the Piper voice.
 */
export async function synthesizeSegments(
  segments: string[],
  baseDir: string,
  opts: SynthesizeOptions & { pauseBetweenMs?: number; pausesAfterMs?: number[] } = {},
): Promise<Buffer> {
  const clean = segments.map((s) => s.trim()).filter(Boolean);
  if (clean.length === 0) throw new Error("No text to synthesize");
  const wavs: Buffer[] = [];
  for (const segment of clean) {
    const wav = await synthesize(segment, baseDir, { lengthScale: opts.lengthScale, voice: opts.voice });
    wavs.push(normalizeWav(wav));
  }
  const pausesAfter = opts.pausesAfterMs ?? [];
  const between = clean.slice(1).map((_, i) => pausesAfter[i] ?? opts.pauseBetweenMs ?? 0);
  // Trailing beat: explicit per-segment pauses win (their last entry is the
  // silence after the final segment), else the legacy `pauseAfterMs`.
  const trailing = opts.pausesAfterMs ? pausesAfter[clean.length - 1] ?? 0 : opts.pauseAfterMs ?? 0;
  return concatWavWithPauses(wavs, between, trailing);
}