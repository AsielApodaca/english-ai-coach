/**
 * Piper TTS — local neural text-to-speech engine.
 *
 * Wraps the `piper` binary (installed via `pipx install piper-tts`).
 * Piper reads the text to speak from **stdin** (it has no `--text` flag).
 * Models (ONNX + JSON) are downloaded from the Rhasspy Piper voices repo on
 * HuggingFace and cached under `models/piper/` inside the project root.
 *
 * Split (feature 117): the voice registry / binary detection / downloader
 * live in {@link ./piper-voices.ts} (re-exported below, so existing
 * `from "./piper.ts"` imports of DEFAULT_VOICE, checkPiper… resolve
 * unchanged) and the PCM16 WAV helpers + `normalizeWav` live in
 * {@link ./wav.ts}. This file is only the synthesis subprocess.
 *
 * Follows the same structural pattern as {@link whisper.ts}.
 */

import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { snip, SUBPROCESS_MAX_BUFFER, SUBPROCESS_TIMEOUT_MS } from "./subprocess.ts";
import { checkPiper, DEFAULT_VOICE } from "./piper-voices.ts";
import { buildWavHeader, concatWavWithPauses, extractWavData, makeSilence, normalizeWav, readWavFormat } from "./wav.ts";

export interface SynthesizeOptions {
  /** Piper `--length-scale` — controls speaking rate. Default ≈ 1 (normal). */
  lengthScale?: number;
  /** Milliseconds of silence to append after the spoken text. */
  pauseAfterMs?: number;
  /** Voice to use (must be in {@link SUPPORTED_VOICES}). Defaults to {@link DEFAULT_VOICE}. */
  voice?: string;
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
      timeout: SUBPROCESS_TIMEOUT_MS,
      maxBuffer: SUBPROCESS_MAX_BUFFER,
    });

    if (res.error) throw new Error(`piper failed to start: ${res.error.message}`);
    if (res.status !== 0) throw new Error(`piper exited ${res.status}: ${snip(res.stderr)}`);

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

// Voice registry / binary detection / downloader (see piper-voices.ts): the
// public import surface of this module stays "everything Piper", so callers
// keep importing DEFAULT_VOICE / checkPiper / SUPPORTED_VOICES from here.
export * from "./piper-voices.ts";
