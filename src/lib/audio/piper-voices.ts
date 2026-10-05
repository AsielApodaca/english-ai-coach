/**
 * Piper voice registry (features 114/117) — split out of `piper.ts`: the
 * supported-voice table, the `piper` binary detection, the install status
 * report and the HuggingFace downloader. No synthesis happens here.
 *
 * Contract:
 *   isVoiceReady(baseDir, voice): boolean        pure file check, no subprocess
 *   checkPiper(baseDir, voice?):   PiperHandle   binary + model status + hint
 *   downloadVoice(voice, baseDir): { onnxPath, jsonPath }
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
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
