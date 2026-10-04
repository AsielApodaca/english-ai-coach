/**
 * Session/profile data model (features 102/104/109/117) — split out of
 * `storage.ts` by feature 117 so the type contract has its own file.
 *
 * Everything here is a type, a type guard for the LEVELS list or a pure
 * helper derived from the model (`fallbackTitle`, `normalizeLevel`): no I/O,
 * no state. `storage.ts` re-exports this file, so existing imports of
 * `./storage.ts` resolve unchanged.
 */

// ---------------------------------------------------------------------------
// Levels — CEFR A1–C2 (expanded from the v1 B1/B2/C1 enum)
// ---------------------------------------------------------------------------

export const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"] as const;
export type Level = (typeof LEVELS)[number];

export function isLevel(v: unknown): v is Level {
  return typeof v === "string" && (LEVELS as readonly string[]).includes(v);
}

/** Coerce an unknown value to a valid CEFR level, falling back to `fallback`. */
export function normalizeLevel(v: unknown, fallback: Level = "B2"): Level {
  return isLevel(v) ? v : fallback;
}

// ---------------------------------------------------------------------------
// v1 model (legacy) — kept exported so the transitional v1 app code can still
// read/write its own sessions; v1 files are migrated to v2 on read only.
// ---------------------------------------------------------------------------

export interface SessionAttempt {
  text: string;
  score: number;
  missing: string[];
  extra: string[];
  issues: FeedbackIssue[];
  verdict: "great" | "almost" | "retry";
}

export interface FeedbackIssue {
  category: "grammar" | "word-choice" | "fluency" | "pronunciation" | "other";
  message: string;
  fix?: string;
}

export interface SessionFragment {
  id: string;
  stage: string;
  text: string;
  attempts: SessionAttempt[];
  passed: boolean;
}

/** @deprecated v1 session model — single question with fragments. */
export interface Session {
  id: string;
  date: string;
  category: string;
  level: string;
  provider: string;
  question: string;
  context: string;
  fragments: SessionFragment[];
  fullAnswer?: {
    text: string;
    score?: number;
    feedback?: string;
  };
  nextStep?: NextStep;
}

export interface NextStep {
  focus: string;
  topic: string;
  why: string;
  targetLevel: string;
  generatedAt: string;
}

/**
 * Profile-persisted settings (feature 108): training + persona settings that
 * survive across sessions. Device prefs (mic, volume, showIpa, autoAdvance,
 * liveHighlight, stt, tempo, whisperModel, voice) live in localStorage instead.
 */
export interface ProfileSettings {
  rigor?: string;
  fillers?: string;
  adaptive?: { enabled?: boolean; up?: number; down?: number };
  provider?: string;
  personaName?: string;
  targetLevel?: string;
  bio?: string;
  prompt?: string;
}

export interface Profile {
  level: Level;
  categories: Record<string, CategoryStats>;
  weakErrors: Record<string, number>;
  vocabGaps: string[];
  recentTopics: string[];
  focusPhonemes?: string[];
  lastSessionAt?: string;
  nextStep?: NextStep;
  settings?: ProfileSettings;
}

export interface CategoryStats {
  sessions: number;
  avgScore: number;
  lastScore?: number;
  trend: number[];
}

// ---------------------------------------------------------------------------
// v2 model — continuous resumable session (feature 102)
// ---------------------------------------------------------------------------

export type SessionStatus = "active" | "completed";
export type WordStatus = "green" | "amber" | "red";

/** Supported context-file formats (feature 104). */
export type FileKind = "pdf" | "docx" | "txt" | "md";

/**
 * Reference to an extracted context file stored in `config.contextFiles[]`
 * (feature 104). The extracted text itself lives under
 * `data/tmp/context/<bucket>/<textRef>` — never duplicated in the session JSON.
 */
export interface ContextFileRef {
  name: string;
  size: number;
  kind: FileKind;
  /** Relative file name of the extracted text under `data/tmp/context/<bucket>/`. */
  textRef: string;
}

/** One word of a spoken attempt, colored for the karaoke line (feature 106). */
export interface AttemptWord {
  word: string;
  status: WordStatus;
  /** Optional per-word timestamps (ms) for the karaoke animation (feature 106). */
  startMs?: number;
  endMs?: number;
}

/** A single spoken attempt at a fragment (or the full answer). */
export interface FragmentAttempt {
  text: string;
  words: AttemptWord[];
  score: number;
  startedAt: string;
  durationMs: number;
}

export interface SessionFragmentV2 {
  id: string;
  text: string;
  attempts: FragmentAttempt[];
  passed: boolean;
}

/** Evaluation of the full answer of a question (shape mirrors practice.ts). */
export interface SessionEval {
  score: number;
  verdict: "great" | "almost" | "retry";
  matched: string[];
  missing: string[];
  extra: string[];
  issues: FeedbackIssue[];
  tips: string[];
  next: boolean;
}

export interface SessionQuestion {
  q: string;
  answer: string;
  fragments: SessionFragmentV2[];
  fullAttempt: FragmentAttempt | null;
  eval: SessionEval | null;
}

/** Settings captured at session creation: only user overrides (delta) + version. */
export interface SettingsSnapshot {
  version: number;
  overrides: Record<string, unknown>;
}

export interface SessionConfig {
  topicPrompt: string;
  level: Level;
  category: string;
  accent: string;
  phonemes: string[];
  contextFiles: ContextFileRef[];
  settingsSnapshot: SettingsSnapshot;
}

export interface SessionV2 {
  id: string;
  status: SessionStatus;
  createdAt: string;
  updatedAt: string;
  config: SessionConfig;
  provider: string;
  questions: SessionQuestion[];
  /** One-line summary for history listings (never the raw topicPrompt). */
  title: string;
}

export interface CreateSessionOptions {
  /** LLM-derived one-line title; falls back to the first words of topicPrompt. */
  title?: string;
  /** LLM provider that generated the first question / title. */
  provider?: string;
}

export interface ListSessionsOptions {
  status?: SessionStatus;
  /** Only sessions with updatedAt >= since (ISO string). */
  since?: string;
  /** Maximum number of sessions to return (newest first). */
  limit?: number;
}

export interface RecencyGroup<T = SessionV2> {
  key: "today" | "yesterday" | "last7" | "older";
  label: string;
  sessions: T[];
}

/**
 * Lightweight history entry (feature 109): everything the sidebar needs to
 * render one session row. Deliberately excludes the full `topicPrompt` and the
 * question bodies — the listing must stay cheap (NFR: light read of
 * `data/sessions`, no content until opened).
 */
export interface SessionProgress {
  answered: number;
  total: number;
  pct: number;
}

export interface SessionSummary {
  id: string;
  title: string;
  level: Level;
  provider: string;
  status: SessionStatus;
  updatedAt: string;
  /** Average pronunciation score across fragment attempts; absent when none. */
  score?: number;
  progress: SessionProgress;
}

export const DEFAULT_ACCENT = "General American (US)";

/** Snapshot used when no settings were captured (e.g. migrated v1 sessions). */
export const DEFAULT_SETTINGS_SNAPSHOT: SettingsSnapshot = { version: 0, overrides: {} };

/** Derive a short title from the topic prompt (first `maxWords` words). */
export function fallbackTitle(topicPrompt: string, maxWords = 8): string {
  const words = topicPrompt.trim().split(/\s+/).filter(Boolean);
  const title = words.slice(0, maxWords).join(" ");
  return title || "Untitled session";
}
