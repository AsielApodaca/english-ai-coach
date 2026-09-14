/**
 * edge-tts — online text-to-speech fallback engine.
 *
 * Wraps the `edge-tts` Python CLI (pip package `edge-tts`) which synthesizes
 * natural-sounding voices through Microsoft Edge's online TTS service.
 * Used as the middle layer of the TTS chain (Piper → edge-tts → browser
 * speechSynthesis) when Piper is not installed locally.
 *
 * edge-tts is an ONLINE engine: it must never run when `OFFLINE_MODE` is set
 * (feature 006). The gate is enforced by the server route, not here.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default voice — a clear, natural English US female voice. */
export const DEFAULT_EDGE_VOICE = "en-US-AriaNeural";

/** Max output size we are willing to hold in memory (~50 MB). */
const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Status of an edge-tts installation. */
export interface EdgeTtsHandle {
  /** True when the `edge-tts` CLI binary was found. */
  available: boolean;
  /** Absolute path to the binary, or null. */
  binary: string | null;
  /** Voice identifier that would be used (e.g. `en-US-AriaNeural`). */
  voiceName: string;
  /** Human-readable hint about what is missing (if anything). */
  hint: string;
}

export interface EdgeSynthesizeOptions {
  /** Edge TTS voice id (defaults to {@link DEFAULT_EDGE_VOICE}). */
  voice?: string;
  /** Speaking rate factor (0.5–2; 1 = normal). Converted to the `--rate` suffix. */
  rate?: number;
}

// ---------------------------------------------------------------------------
// checkEdgeTts
// ---------------------------------------------------------------------------

/** Build the edge-tts `--rate` argument from a speed factor (1 = normal). */
export function edgeRateArg(rate: number): string {
  const pct = Math.round((rate - 1) * 100);
  return `${pct > 0 ? "+" : ""}${pct}%`;
}

/** Check whether the `edge-tts` CLI is installed. */
export function checkEdgeTts(): EdgeTtsHandle {
  const binary = findBinary();
  let hint = "";
  if (!binary) {
    hint = 'edge-tts not found. Install with: pip install edge-tts (or run "npm run setup -- --tts --edge").';
  }
  return {
    available: binary !== null,
    binary,
    voiceName: DEFAULT_EDGE_VOICE,
    hint,
  };
}

/** Try to locate the `edge-tts` binary on PATH and common install locations. */
function findBinary(): string | null {
  try {
    const found = execFileSync("which", ["edge-tts"], { encoding: "utf8" }).trim();
    if (found) return found;
  } catch {
    // not on PATH
  }
  const home = process.env.HOME ?? "";
  const extras = [
    join(home, ".local/bin/edge-tts"),
    "/opt/homebrew/bin/edge-tts",
    "/usr/local/bin/edge-tts",
  ];
  for (const p of extras) {
    if (existsSync(p)) return p;
  }
  return null;
}

// ---------------------------------------------------------------------------
// synthesizeEdge
// ---------------------------------------------------------------------------

/**
 * Synthesize text to an audio buffer using the edge-tts CLI.
 *
 * Spawns `edge-tts --voice <voice> --text <text> --write-media <tmp.mp3>`,
 * reads the resulting file, and returns the buffer (MP3 bytes). Temp files
 * are removed automatically.
 *
 * @param text The text to speak (must be ≤ 1000 characters).
 * @param baseDir Project root — used to resolve the temp dir.
 * @param opts Optional `voice` override and `rate` speed factor.
 * @throws If the CLI is missing, exits non-zero, or produces no output.
 */
export async function synthesizeEdge(
  text: string,
  baseDir: string,
  opts: EdgeSynthesizeOptions = {},
): Promise<Buffer> {
  const edge = checkEdgeTts();
  if (!edge.available || !edge.binary) {
    throw new Error("edge-tts-unavailable: " + edge.hint);
  }

  const tmpDir = join(baseDir, "data", "tmp");
  mkdirSync(tmpDir, { recursive: true });
  const outPath = join(tmpDir, `edge-${randomUUID()}.mp3`);

  try {
    const voice = opts.voice ?? DEFAULT_EDGE_VOICE;
    // A leading "-" would be parsed as an argparse option; prefix with a space.
    const safeText = text.startsWith("-") ? ` ${text}` : text;
    const args = ["--voice", voice, "--text", safeText, "--write-media", outPath];
    if (opts.rate != null && Number.isFinite(opts.rate)) {
      args.push("--rate", edgeRateArg(opts.rate));
    }
    const res = spawnSync(edge.binary, args, {
      encoding: "utf8",
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (res.error) throw new Error(`edge-tts failed to start: ${res.error.message}`);
    if (res.status !== 0) {
      throw new Error(`edge-tts exited ${res.status}: ${(res.stderr ?? "").slice(0, 500)}`);
    }
    if (!existsSync(outPath)) {
      throw new Error("edge-tts produced no output file");
    }

    const audio = readFileSync(outPath);
    if (audio.length > MAX_OUTPUT_BYTES) {
      throw new Error("edge-tts output exceeds size limit");
    }
    return audio;
  } finally {
    rmSync(outPath, { force: true });
  }
}