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

export interface WhisperWord {
  word: string;
  startMs: number;
  endMs: number;
}

export interface TranscribeWordsResult extends TranscribeResult {
  words: WhisperWord[];
}

/** Convert a seconds float to rounded milliseconds. */
function secondsToMs(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
}

/**
 * Convert a whisper timestamp value to milliseconds.
 * Accepts the two shapes whisper.cpp emits:
 *  - bare float-seconds strings, e.g. `"1.00"` → 1000
 *  - `HH:MM:SS,mmm` strings, e.g. `"00:00:01,120"` → 1120
 */
function timestampToMs(value: unknown): number {
  if (typeof value !== "string") return 0;
  const bare = Number(value);
  if (Number.isFinite(bare) && value.trim() !== "") return Math.round(bare * 1000);
  const m = value.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return 0;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const ms = Number(m[4].padEnd(3, "0"));
  return h * 3_600_000 + min * 60_000 + s * 1000 + ms;
}

/**
 * Treat a whisper `offsets` value as integral milliseconds (the unit whisper.cpp
 * actually emits in `-oj` output; NOT seconds — do not apply `secondsToMs`).
 */
function offsetsToMs(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/**
 * Extract a single word from a whisper segment object (any timestamp shape).
 * Timestamp resolution order:
 *   1. numeric `start`/`end` (seconds) — used by the old v1 JSON layouts
 *   2. `timestamps` (HH:MM:SS,mmm or bare-second strings) — unambiguous, preferred over `offsets`
 *   3. `offsets` (milliseconds) — the unit whisper.cpp `-oj`/`-ml 1` emits
 */
function segmentToWord(seg: unknown): WhisperWord | null {
  if (!seg || typeof seg !== "object") return null;
  const s = seg as Record<string, unknown>;
  const word = typeof s.text === "string" ? s.text.trim() : "";
  if (!word) return null;
  let startMs = 0;
  let endMs = 0;
  if (typeof s.start === "number" && typeof s.end === "number") {
    startMs = secondsToMs(s.start);
    endMs = secondsToMs(s.end);
  } else if (s.timestamps && typeof s.timestamps === "object") {
    const t = s.timestamps as Record<string, unknown>;
    startMs = timestampToMs(t.from);
    endMs = timestampToMs(t.to);
  } else if (s.offsets && typeof s.offsets === "object") {
    const o = s.offsets as Record<string, unknown>;
    startMs = offsetsToMs(o.from);
    endMs = offsetsToMs(o.to);
  }
  return { word, startMs, endMs };
}

/** Locate the word/segment array inside a parsed whisper JSON object. */
function findWordArray(obj: Record<string, unknown>): unknown[] | null {
  for (const key of ["segments", "timestamps", "offsets", "transcription"]) {
    const v = obj[key];
    if (Array.isArray(v) && v.length > 0) return v;
  }
  return null;
}

/**
 * Parse a whisper-cli JSON transcript into word-level entries plus the full
 * text. Robust to the output shape variants of whisper.cpp (`segments` with
 * `start`/`end` in seconds, `transcription` with `offsets`/`timestamps`, etc.).
 */
function parseWhisperJSON(raw: string): { words: WhisperWord[]; text: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { words: [], text: "" };
  }
  if (!data || typeof data !== "object") return { words: [], text: "" };
  const obj = data as Record<string, unknown>;
  const arr = findWordArray(obj);
  let words: WhisperWord[] = [];
  if (arr) {
    words = arr.map(segmentToWord).filter((w): w is WhisperWord => w !== null);
  }
  let text = typeof obj.text === "string" ? obj.text.trim() : "";
  if (!text && typeof obj.transcription === "string") text = obj.transcription.trim();
  if (words.length === 0) {
    // Keep at least the full transcript as a single token so callers always
    // have something to align against.
    if (!text && arr) {
      const parts = arr
        .map((s) =>
          s && typeof s === "object" && typeof (s as Record<string, unknown>).text === "string"
            ? ((s as Record<string, unknown>).text as string).trim()
            : "",
        )
        .filter(Boolean);
      if (parts.length) text = parts.join(" ");
    }
    if (text) words = [{ word: text, startMs: 0, endMs: 0 }];
  }
  return { words, text };
}

/**
 * Parse a whisper-cli JSON transcript into word-level entries.
 * Pure helper (no binary required) so it can be unit-tested in isolation.
 */
export function parseWhisperWordsJSON(raw: string): WhisperWord[] {
  return parseWhisperJSON(raw).words;
}

/**
 * Transcribe a 16kHz mono WAV file with whisper-cli, emitting one word per
 * segment with per-word timestamps (milliseconds).
 */
export async function transcribeWords(
  wavPath: string,
  modelFile: string,
  baseDir: string,
  language = "en",
): Promise<TranscribeWordsResult> {
  const binary = findBinary();
  if (!binary) throw new Error("whisper-cli not found. Run: brew install whisper-cpp");
  const started = Date.now();
  const outDir = join(baseDir, "data", "tmp");
  mkdirSync(outDir, { recursive: true });
  const outPrefix = join(outDir, `whisper-${Date.now()}`);
  const args = ["-m", modelFile, "-f", wavPath, "-l", language, "-oj", "-ml", "1", "-of", outPrefix, "-nt", "-np"];
  const res = spawnSync(binary, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 10 * 1024 * 1024 });
  if (res.error) throw new Error(`whisper-cli failed to start: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`whisper-cli exited ${res.status}: ${res.stderr.slice(0, 500)}`);
  const jsonPath = `${outPrefix}.json`;
  let words: WhisperWord[] = [];
  let text = "";
  if (existsSync(jsonPath)) {
    const parsed = parseWhisperJSON(readFileSync(jsonPath, "utf8"));
    words = parsed.words;
    text = parsed.text;
  }
  rmSync(jsonPath, { force: true });
  if (!text && words.length > 0) text = words.map((w) => w.word).join(" ");
  return { text, words, durationMs: Date.now() - started };
}