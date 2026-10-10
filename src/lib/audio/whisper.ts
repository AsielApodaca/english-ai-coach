import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { snip, SUBPROCESS_TIMEOUT_MS } from "../util/subprocess.ts";
import { MS_PER_MIN, MS_PER_S } from "../util/time.ts";

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

/**
 * Whisper model used when the `WHISPER_MODEL` env var is unset — the single
 * source for the default previously inlined as `"small.en"` in server.ts
 * (feature 117: the route modules read the env with this constant).
 */
export const DEFAULT_WHISPER_MODEL = "small.en";

/**
 * Memoized result of the PATH lookup: the resolved binary path, or `null`
 * while none has been found. ONLY a successful lookup is cached (feature 121):
 * a negative result would freeze availability forever — e.g. a test (or a
 * user installing whisper while the app runs) must be able to flip it.
 */
let cachedBinary: string | null = null;

function findBinary(): string | null {
  if (cachedBinary) return cachedBinary;
  const candidates = ["whisper-cli", "whisper"];
  for (const name of candidates) {
    try {
      const found = execFileSync("which", [name], { encoding: "utf8" }).trim();
      if (found) {
        cachedBinary = found;
        return found;
      }
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
  renameSync(tmp, target);
  return target;
}

export interface TranscribeResult {
  text: string;
  durationMs: number;
}

/** Per-run knobs of the shared whisper-cli spawn (feature 121). */
export interface TranscribeOptions {
  /**
   * Wall-clock budget for the run (defaults to SUBPROCESS_TIMEOUT_MS). The
   * partial-transcription route passes a smaller, NAMED budget of its own so
   * a stuck window never holds the 60 s shared with piper/edge-tts.
   */
  timeoutMs?: number;
  /**
   * Aborting it kills the whisper child (feature 121: the client of
   * `POST /api/transcribe-partial` disconnects after releasing push-to-talk;
   * the orphan run would burn CPU against the final `/api/attempt` spawn).
   */
  signal?: AbortSignal;
}

/** Outcome of one async whisper-cli run, mirroring the spawnSync fields. */
interface RunWhisperResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Spawn whisper-cli asynchronously (feature 121 — replaced `spawnSync`, which
 * blocked the whole event loop for every run: TTS, health and the long-poll
 * of 116 stalled behind each transcription).
 *
 * Semantics preserved from the old `spawnSync` call sites:
 *   - a spawn failure REJECTS with `whisper-cli failed to start: …`;
 *   - a non-zero exit RESOLVES (status/stderr reported, caller throws).
 * New, async-only outcomes also reject, with explicit messages: a run over
 * `timeoutMs` (child killed with SIGTERM) and an `options.signal` abort
 * (same kill — client disconnect). The child is settled exactly once.
 *
 * @param binary - resolved path of the CLI (from `findBinary`)
 * @param args - CLI arguments
 * @param options - timeout budget (required) and optional abort signal
 */
function runWhisper(
  binary: string,
  args: string[],
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<RunWhisperResult> {
  const { timeoutMs, signal } = options;
  return new Promise<RunWhisperResult>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("whisper-cli aborted (client disconnected)"));
      return;
    }
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    /** Kill the child and reject — first caller wins over 'close'. */
    const die = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      child.kill("SIGTERM");
      reject(err);
    };

    const onAbort = () => die(new Error("whisper-cli aborted (client disconnected)"));
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => die(new Error(`whisper-cli timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );

    child.on("error", (err: Error) => {
      die(new Error(`whisper-cli failed to start: ${err.message}`));
    });
    // 'close' (not 'exit'): the stdio streams are drained, so stdout/stderr
    // hold the complete output of the run.
    child.on("close", (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ status: code, stdout, stderr });
    });
  });
}

/** Unique output prefix per run: concurrent runs must never share a file. */
function whisperOutPrefix(baseDir: string): string {
  const outDir = join(baseDir, "data", "tmp");
  mkdirSync(outDir, { recursive: true });
  return join(outDir, `whisper-${randomUUID()}`);
}

/** Transcribe a 16kHz mono WAV file with whisper-cli (async spawn, feature 121). */
export async function transcribeWav(
  wavPath: string,
  modelFile: string,
  baseDir: string,
  language = "en",
  options: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const binary = findBinary();
  if (!binary) throw new Error("whisper-cli not found. Run: brew install whisper-cpp");
  const started = Date.now();
  const outPrefix = whisperOutPrefix(baseDir);
  const args = ["-m", modelFile, "-f", wavPath, "-l", language, "-otxt", "-of", outPrefix, "-nt", "-np"];
  const res = await runWhisper(binary, args, {
    timeoutMs: options.timeoutMs ?? SUBPROCESS_TIMEOUT_MS,
    signal: options.signal,
  });
  if (res.status !== 0) throw new Error(`whisper-cli exited ${res.status}: ${snip(res.stderr)}`);
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
  return Number.isFinite(n) ? Math.round(n * MS_PER_S) : 0;
}

/**
 * Convert a whisper timestamp value to milliseconds. Accepts the two shapes
 * whisper.cpp emits: bare float-seconds strings (`"1.00"` → 1000) and
 * `HH:MM:SS,mmm` strings (`"00:00:01,120"` → 1120).
 */
function timestampToMs(value: unknown): number {
  if (typeof value !== "string") return 0;
  const bare = Number(value);
  if (Number.isFinite(bare) && value.trim() !== "") return Math.round(bare * MS_PER_S);
  const m = value.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[,.](\d{1,3})$/);
  if (!m) return 0;
  const h = Number(m[1] ?? 0);
  const min = Number(m[2]);
  const s = Number(m[3]);
  const ms = Number(m[4].padEnd(3, "0"));
  return h * 3_600_000 + min * MS_PER_MIN + s * MS_PER_S + ms;
}

/**
 * Treat a whisper `offsets` value as integral milliseconds (the unit
 * whisper.cpp emits in `-oj` output; NOT seconds — do not use `secondsToMs`).
 */
function offsetsToMs(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Whisper non-speech annotations it emits for silence/noise ([BLANK_AUDIO]). */
const ANNOTATION_RE = /\[[^\]]*\]/g;

/** Drop whisper annotations; an empty result means the segment has no speech. */
function stripAnnotations(text: string): string {
  return text.replace(ANNOTATION_RE, " ").replace(/\s+/g, " ").trim();
}

/**
 * Extract a single word from a whisper segment object (any timestamp shape).
 * Annotation-only segments ([BLANK_AUDIO] on a silent recording) return null
 * so they never reach word matching as phantom words. Timestamp resolution
 * order: 1. numeric `start`/`end` (seconds, old v1 layouts); 2. `timestamps`
 * (HH:MM:SS,mmm or bare-second strings, preferred over `offsets`); 3.
 * `offsets` (milliseconds, the unit whisper.cpp `-oj`/`-ml 1` emits).
 */
function segmentToWord(seg: unknown): WhisperWord | null {
  if (!seg || typeof seg !== "object") return null;
  const s = seg as Record<string, unknown>;
  const word = stripAnnotations(typeof s.text === "string" ? s.text : "");
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
 * text, robust to the output shape variants of whisper.cpp (`segments` with
 * `start`/`end` in seconds, `transcription` with `offsets`/`timestamps`).
 * Annotations ([BLANK_AUDIO], [MUSIC], …) are stripped from both words and
 * text: a silent recording transcribes to `{ words: [], text: "" }`.
 */
export function parseWhisperJSON(raw: string): { words: WhisperWord[]; text: string } {
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
  let text = typeof obj.text === "string" ? obj.text : "";
  if (!text && typeof obj.transcription === "string") text = obj.transcription;
  text = stripAnnotations(text);
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
      if (parts.length) text = stripAnnotations(parts.join(" "));
    }
    if (text) words = [{ word: text, startMs: 0, endMs: 0 }];
  }
  return { words, text };
}

/** Word-level entries of a whisper-cli JSON transcript (pure, unit-testable). */
export function parseWhisperWordsJSON(raw: string): WhisperWord[] {
  return parseWhisperJSON(raw).words;
}

/** Transcribe with whisper-cli emitting one word per segment (-oj -ml 1 -sow). */
export async function transcribeWords(
  wavPath: string,
  modelFile: string,
  baseDir: string,
  language = "en",
  options: TranscribeOptions = {},
): Promise<TranscribeWordsResult> {
  const binary = findBinary();
  if (!binary) throw new Error("whisper-cli not found. Run: brew install whisper-cpp");
  const started = Date.now();
  const outPrefix = whisperOutPrefix(baseDir);
  // -ml 1: one entry per segment; -sow (--split-on-word): split at word
  // boundaries instead of tokenizer (BPE) token boundaries. Without -sow,
  // whisper emits sub-word tokens (" autom" + " ating", " fl" + "aky",
  // " end" + "-" + "to"), which downstream word matching reports as
  // missing/extra words.
  const args = ["-m", modelFile, "-f", wavPath, "-l", language, "-oj", "-ml", "1", "-sow", "-of", outPrefix, "-nt", "-np"];
  const res = await runWhisper(binary, args, {
    timeoutMs: options.timeoutMs ?? SUBPROCESS_TIMEOUT_MS,
    signal: options.signal,
  });
  if (res.status !== 0) throw new Error(`whisper-cli exited ${res.status}: ${snip(res.stderr)}`);
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