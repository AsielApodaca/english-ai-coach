/**
 * Context file ingestion (feature 104) — split out of `extract.ts` by
 * feature 117: pure extraction + sanitization + prompt-injection helpers for
 * the CU1 dropzone.
 *
 * TXT/MD are read directly (strict UTF-8); PDF goes through `pdf-parse`;
 * DOCX through `mammoth` — the only two npm dependencies allowed besides
 * Express (see spec/constitution/tech-stack.md).
 *
 * The original file is NEVER sent anywhere external: only the extracted text
 * is persisted (under data/tmp/context/) and later injected into the LLM
 * prompt wrapped in the "DOCUMENT CONTEXT" block built here.
 */

import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";
import { completeWithFallback } from "../providers/index.ts";
import type { Candidate } from "../practice/practice.ts";
import type { ContextFileRef, FileKind } from "../session/storage.ts";

/** Per-file extraction limits (configurable; defaults below). */
export interface ExtractLimits {
  /** Maximum accepted file size in bytes (default 10 MB). */
  maxBytes: number;
  /** Maximum characters kept per file after trimming (default 40k). */
  maxChars: number;
}

/** One mebibyte in bytes, so size limits read as multiples of a unit. */
const MIB = 1024 * 1024;

/** Default per-file size limit: 10 MiB. */
export const DEFAULT_MAX_BYTES = 10 * MIB;
/** Default per-file character budget after extraction. */
export const DEFAULT_MAX_CHARS = 40_000;
/** Prompt-injection budget for the DOCUMENT CONTEXT block (16k chars). */
export const CONTEXT_BUDGET = 16_000;
/** Bucket used when no session exists yet (CU1 dropzone happens pre-session). */
export const DEFAULT_CONTEXT_BUCKET = "draft";
/** Words below this make the soft language detector answer "unknown" (feature 104). */
export const MIN_LANG_WORDS = 10;
/** Hard cap of document text sent to the summarizer prompt (chars, feature 104). */
export const DOC_CHAR_BUDGET = 100_000;
/** Sampling temperature of the context summarizer (factual, low-creativity text). */
export const EXTRACT_LLM_TEMPERATURE = 0.2;
/** Response budget of the context summarizer (tokens). */
export const EXTRACT_LLM_MAX_TOKENS = 4096;

const SUPPORTED_EXTENSIONS: Record<string, FileKind> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".txt": "txt",
  ".md": "md",
};

/** Error thrown for unparseable / rejected files; the endpoint maps it to `{ error }`. */
export class ExtractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractError";
  }
}

/** Extracted file plus its extracted text (before persistence). */
export interface ExtractedFile extends ContextFileRef {
  text: string;
  /** True when the raw extraction exceeded the per-file char budget and was trimmed. */
  truncated: boolean;
}

/** Minimal persistence surface the extract handler needs (implemented by storage.ts). */
export interface ContextStorage {
  saveContextText(bucket: string, file: { name: string; size: number; kind: FileKind }, text: string): string;
}

/**
 * Detect the file kind from the extension, case-insensitively.
 * Returns `undefined` for unsupported or extension-less names.
 */
export function detectKind(name: string): FileKind | undefined {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return undefined;
  return SUPPORTED_EXTENSIONS[name.slice(dot).toLowerCase()];
}

/**
 * Strip NUL bytes, ANSI escape sequences (CSI) and C0 control characters
 * (keeping `\t`, `\n`, `\r`) plus DEL. This removes escape sequences and
 * binary noise from extracted text.
 */
export function sanitizeText(text: string): string {
  return text
    .replace(/\u0000/g, "")
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/**
 * Trim `text` to `budget` characters, cutting at the last word boundary when
 * possible so the LLM never receives a mid-word fragment.
 */
export function trimToBudget(text: string, budget: number = DEFAULT_MAX_CHARS): string {
  if (text.length <= budget) return text;
  const cut = text.slice(0, budget);
  const lastSpace = cut.lastIndexOf(" ");
  return lastSpace > 0 ? cut.slice(0, lastSpace) : cut;
}

/**
 * Extract plain text from a file buffer for the given kind.
 * TXT/MD use a strict UTF-8 decode (throws on undecodable binaries); PDF uses
 * `pdf-parse` (per-page text joined with newlines); DOCX uses `mammoth`.
 * Parse failures are wrapped in `ExtractError` with a friendly message.
 */
export async function extractText(kind: FileKind, buffer: Buffer): Promise<string> {
  try {
    switch (kind) {
      case "txt":
      case "md":
        return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      case "pdf": {
        const parser = new PDFParse({ data: buffer });
        try {
          const result = await parser.getText({ pageJoiner: "\n" });
          return result.text;
        } finally {
          await parser.destroy();
        }
      }
      case "docx": {
        const result = await mammoth.extractRawText({ buffer });
        return result.value;
      }
    }
  } catch (err) {
    if (err instanceof ExtractError) throw err;
    throw new ExtractError(`Could not parse ${kind} file: ${(err as Error).message}`);
  }
}

/**
 * Validate + extract + sanitize + trim a single uploaded file.
 * Throws `ExtractError` with a friendly message for unsupported extensions,
 * oversized files and unparseable content.
 */
export async function extractFile(name: string, buffer: Buffer, limits?: Partial<ExtractLimits>): Promise<ExtractedFile> {
  const kind = detectKind(name);
  if (!kind) throw new ExtractError("Unsupported file type. Supported: .pdf, .docx, .txt, .md");
  const maxBytes = limits?.maxBytes ?? DEFAULT_MAX_BYTES;
  if (buffer.length > maxBytes) throw new ExtractError(`File exceeds the ${maxBytes}-byte size limit.`);
  const maxChars = limits?.maxChars ?? DEFAULT_MAX_CHARS;
  let raw: string;
  try {
    raw = await extractText(kind, buffer);
  } catch (err) {
    throw new ExtractError(`Could not parse ${name}: ${(err as Error).message}`);
  }
  const text = sanitizeText(trimToBudget(raw, maxChars));
  return { name, size: buffer.length, kind, text, textRef: "", truncated: raw.length > maxChars };
}

/**
 * Build the "DOCUMENT CONTEXT" block injected into the LLM prompt (consumed by
 * features 103/105). File text stays RAW — only the wrapper is ours. Each file
 * gets a proportional share of `budget` so every document is represented.
 * Returns "" when there are no files.
 */
export function buildDocumentContext(files: ExtractedFile[], budget: number = CONTEXT_BUDGET): string {
  if (files.length === 0 || budget <= 0) return "";
  const totalChars = files.reduce((sum, f) => sum + f.text.length, 0);
  const parts = files.map((f) => {
    const share = totalChars === 0 ? 0 : Math.max(1, Math.floor((f.text.length / totalChars) * budget));
    return `--- ${f.name} (${f.kind}) ---\n${trimToBudget(f.text, share)}`;
  });
  return `DOCUMENT CONTEXT\n${parts.join("\n\n")}`;
}

/** Signature of the LLM summarizer injected into `summarizeContext`. */
export type SummarizeFn = (text: string, budget: number) => Promise<string>;

/**
 * Summarize the combined file texts so they fit the prompt budget. When the
 * total is already within budget the documents are returned as-is (wrapped).
 * If the LLM fails, it falls back to plain truncation (graceful degradation).
 */
export async function summarizeContext(
  files: ExtractedFile[],
  llm: SummarizeFn,
  budget: number = CONTEXT_BUDGET,
): Promise<string> {
  const totalChars = files.reduce((sum, f) => sum + f.text.length, 0);
  if (totalChars <= budget) return buildDocumentContext(files, budget);
  try {
    const combined = files.map((f) => `--- ${f.name} (${f.kind}) ---\n${f.text}`).join("\n\n");
    const summary = await llm(combined, budget);
    return `DOCUMENT CONTEXT (summarized)\n${trimToBudget(summary, budget)}`;
  } catch {
    return buildDocumentContext(files, budget);
  }
}

// ---------------------------------------------------------------------------
// Soft language detection (spec: "detector de idioma suave")
// ---------------------------------------------------------------------------

const STOPWORDS: Record<string, string[]> = {
  en: ["the", "and", "of", "to", "in", "is", "that", "for", "with", "on", "as", "by"],
  es: ["el", "la", "de", "que", "y", "en", "los", "las", "un", "una", "del", "con"],
  fr: ["le", "la", "les", "de", "des", "et", "en", "un", "une", "que", "du", "pour"],
  de: ["der", "die", "das", "und", "von", "mit", "den", "dem", "zu", "ist", "ein", "eine"],
};

/**
 * Heuristic language detector based on stopword frequency (en/es/fr/de).
 * Returns "unknown" for short or inconclusive texts. This is intentionally
 * soft — it only informs the summarizer prompt, never gates behavior.
 */
export function detectLanguage(text: string): string {
  const words = text.toLowerCase().match(/[a-zà-ÿ]+/g) ?? [];
  if (words.length < MIN_LANG_WORDS) return "unknown";
  let best = "unknown";
  let bestScore = 0;
  for (const [lang, stops] of Object.entries(STOPWORDS)) {
    const score = words.filter((w) => stops.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      best = lang;
    }
  }
  return bestScore === 0 ? "unknown" : best;
}

/**
 * Build a `SummarizeFn` backed by the existing provider/fallback LLM layer.
 * The caller (features 103/105) should pass `learnerMemory` when available so
 * the summarization respects the project rule of including learner memory.
 */
export function createLLMSummarizer(candidates: Candidate[], opts: { learnerMemory?: string } = {}): SummarizeFn {
  return async (text, budget) => {
    const lang = detectLanguage(text);
    const memoryLine = opts.learnerMemory ? `\nLearner memory: ${opts.learnerMemory}` : "";
    const system =
      "You are a precise document summarizer for an English speaking coach. " +
      "Summarize the document in clear English, keeping all technical terms, names and numbers. " +
      "Do not add commentary outside the summary.";
    const user =
      `Summarize the following document in English. Keep the summary under ${budget} characters.\n` +
      `Detected document language: ${lang}.${memoryLine}\n\nDOCUMENT:\n${trimToBudget(text, DOC_CHAR_BUDGET)}`;
    const res = await completeWithFallback(
      candidates,
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      { temperature: EXTRACT_LLM_TEMPERATURE, maxTokens: EXTRACT_LLM_MAX_TOKENS },
    );
    return res.text;
  };
}
