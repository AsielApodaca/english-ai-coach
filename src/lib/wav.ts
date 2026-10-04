/**
 * WAV/RIFF buffer handling: upload validation, PCM16 building and the
 * server-side level normalization (features 106/114/117).
 *
 * Two halves, one domain:
 *   1. `isWavBuffer` — shallow header check for an uploaded recording
 *      (feature 117): `POST /api/transcribe` wrote the body to disk and
 *      spawned `whisper-cli` on it without checking the format first, so a
 *      non-WAV body ended in a confusing 500 after touching the disk. The
 *      guard runs BEFORE the temp file exists → a bad upload is a clean
 *      400 { error }. Deliberately shallow: RIFF/WAVE magic + the 44-byte
 *      canonical header; whisper.cpp reports real decode problems itself.
 *   2. PCM16 helpers moved out of `piper.ts` (feature 117): header read/build,
 *      silence, concatenation with pauses and `normalizeWav` (RMS target +
 *      peak ceiling + anti-click fades).
 */

// Shared with the client gain (public/speech/level.js): one MAX_BOOST for
// both normalizers so server WAV and edge MP3 behave identically (review #3).
import { MAX_BOOST } from "../../public/speech/level.js";

/** Bytes of the canonical 16-bit PCM header (RIFF…data size field inclusive). */
const MIN_WAV_HEADER_BYTES = 44;

/**
 * Whether `buf` looks like a RIFF/WAVE audio file.
 *
 * Checks bytes 0..4 "RIFF", bytes 8..12 "WAVE" and a length of at least the
 * 44-byte canonical header. Operates on latin1 (byte → char) so the check
 * never depends on the text encoding of the runtime.
 */
export function isWavBuffer(buf: Uint8Array): boolean {
  if (buf.length < MIN_WAV_HEADER_BYTES) return false;
  return readTag(buf, 0, 4) === "RIFF" && readTag(buf, 8, 4) === "WAVE";
}

/** Read `length` bytes at `offset` as latin1 characters (byte-exact). */
function readTag(buf: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = offset; i < offset + length; i++) out += String.fromCharCode(buf[i]);
  return out;
}

// ---------------------------------------------------------------------------
// PCM16 WAV helpers (moved from piper.ts, feature 117)
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
export function readWavFormat(buf: Buffer): {
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
export function extractWavData(buf: Buffer): Buffer {
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
  // while the peak stays ≤ ceiling, so the result can never clip). The boost
  // is additionally capped at MAX_BOOST (+12 dB, shared with the client gain)
  // so a near-silent file is never amplified into hiss.
  const gainRms = Math.pow(10, (rmsTargetDbfs - rmsDb) / 20);
  const gainPeak = Math.pow(10, (peakCeilingDbfs - 20 * Math.log10(peakLin)) / 20);
  const gain = Math.min(gainRms, gainPeak, MAX_BOOST);

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
