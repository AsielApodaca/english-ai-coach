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
 * bit depth, channels). Inserts `pauseMs` milliseconds of silence between
 * each pair of adjacent clips. Returns a single WAV buffer.
 */
export function concatWavWithPauses(buffers: Buffer[], pauseMs: number): Buffer {
  if (buffers.length === 0) {
    throw new Error("No WAV buffers to concatenate");
  }
  if (buffers.length === 1 && pauseMs <= 0) return buffers[0];

  // Read format info from the first WAV header.
  const fmt = readWavFormat(buffers[0]);

  // Build a list of data-only chunks.
  const chunks: Buffer[] = [];
  for (let i = 0; i < buffers.length; i++) {
    if (i > 0 && pauseMs > 0) {
      // Strip the silence's own WAV header — only raw PCM belongs in the data region.
      chunks.push(extractWavData(makeSilence(pauseMs, fmt)));
    }
    chunks.push(extractWavData(buffers[i]));
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
 * between them. Useful for "Repeat after me… [pause] …fragment" flows where
 * the browser should receive one audio file, not a sequence.
 *
 * @param segments  Texts to speak, in order (each ≤ 1000 chars).
 * @param baseDir   Project root.
 * @param opts      `pauseBetweenMs` controls the silence between segments;
 *                  `lengthScale` controls the overall speaking rate; `voice`
 *                  selects the Piper voice.
 */
export async function synthesizeSegments(
  segments: string[],
  baseDir: string,
  opts: SynthesizeOptions & { pauseBetweenMs?: number } = {},
): Promise<Buffer> {
  const clean = segments.map((s) => s.trim()).filter(Boolean);
  if (clean.length === 0) throw new Error("No text to synthesize");
  const wavs: Buffer[] = [];
  for (const segment of clean) {
    wavs.push(await synthesize(segment, baseDir, { lengthScale: opts.lengthScale, voice: opts.voice }));
  }
  return concatWavWithPauses(wavs, opts.pauseBetweenMs ?? 0);
}