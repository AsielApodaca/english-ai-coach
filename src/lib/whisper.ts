import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const MODELS: Record<string, string> = {
  "tiny.en": "ggml-tiny.en.bin",
  "base.en": "ggml-base.en.bin",
  "small.en": "ggml-small.en.bin",
  "medium.en": "ggml-medium.en.bin",
  "tiny": "ggml-tiny.bin",
  "base": "ggml-base.bin",
  "small": "ggml-small.bin",
  "medium": "ggml-medium.bin",
};

const HF_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

function findBinary(): string | null {
  const candidates = ["whisper-cli", "whisper"];
  for (const name of candidates) {
    try {
      const found = execFileSync("which", [name], { encoding: "utf8" }).trim();
      if (found) return found;
    } catch {
      // not in PATH
    }
  }
  return null;
}

function modelFileName(model: string): string {
  if (MODELS[model]) return MODELS[model];
  return model.endsWith(".bin") ? model.split("/").pop()! : `ggml-${model}.bin`;
}

export interface WhisperHandle {
  available: boolean;
  binary: string | null;
  modelName: string;
  modelFile: string;
  modelReady: boolean;
  modelPath: string | null;
  hint: string;
}

/** Check if whisper.cpp is installed and whether the model file exists. */
export function checkWhisper(model: string, baseDir: string): WhisperHandle {
  const binary = findBinary();
  const fileName = modelFileName(model);
  const modelsDir = join(baseDir, "models");
  const modelPath = join(modelsDir, fileName);
  return {
    available: binary !== null,
    binary,
    modelName: model,
    modelFile: fileName,
    modelReady: existsSync(modelPath),
    modelPath: existsSync(modelPath) ? modelPath : null,
    hint: binary
      ? `Run "npm run setup" to download the ${model} model.`
      : "Whisper not found. Install it with: brew install whisper-cpp (then run \"npm run setup\").",
  };
}

/** Download the ggml model file into models/. Uses fetch + write. */
export async function downloadModel(model: string, baseDir: string): Promise<string> {
  const fileName = modelFileName(model);
  const modelsDir = join(baseDir, "models");
  mkdirSync(modelsDir, { recursive: true });
  const target = join(modelsDir, fileName);
  if (existsSync(target)) return target;
  const url = `${HF_BASE}/${fileName}`;
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Failed to download model ${fileName}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const tmp = `${target}.downtmp`;
  writeFileSync(tmp, buf);
  rmSync(target, { force: true });
  const { renameSync } = await import("node:fs");
  renameSync(tmp, target);
  return target;
}

export interface TranscribeResult {
  text: string;
  durationMs: number;
}

/** Transcribe a 16kHz mono WAV file with whisper-cli. */
export async function transcribeWav(
  wavPath: string,
  modelFile: string,
  baseDir: string,
  language = "en",
): Promise<TranscribeResult> {
  const binary = findBinary();
  if (!binary) throw new Error("whisper-cli not found. Run: brew install whisper-cpp");
  const started = Date.now();
  const outDir = join(baseDir, "data", "tmp");
  mkdirSync(outDir, { recursive: true });
  const outPrefix = join(outDir, `whisper-${Date.now()}`);
  const args = ["-m", modelFile, "-f", wavPath, "-l", language, "-otxt", "-of", outPrefix, "-nt", "-np"];
  const res = spawnSync(binary, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  if (res.error) throw new Error(`whisper-cli failed to start: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`whisper-cli exited ${res.status}: ${res.stderr.slice(0, 500)}`);
  const txtPath = `${outPrefix}.txt`;
  const text = existsSync(txtPath) ? readFileSync(txtPath, "utf8").trim() : "";
  rmSync(`${outPrefix}.txt`, { force: true });
  return { text, durationMs: Date.now() - started };
}