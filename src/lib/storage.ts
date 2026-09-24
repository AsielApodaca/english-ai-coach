import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
  prepTime?: number;
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

interface Storage {
  dataDir: string;
  profilePath: string;
  sessionsDir: string;
  tmpDir: string;
}

function mkdirp(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Write file atomically: temp file + rename (avoids corruption on crash). */
function writeJSONAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, file);
}

/** Start of the local calendar day for `d`. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Session ids are generated UUIDs; reject anything that could escape the sessions dir. */
function isValidSessionId(id: string): boolean {
  return /^[a-zA-Z0-9-]+$/.test(id);
}

/** Context buckets are session ids or the "draft" bucket; never path-escape. */
function isValidBucket(bucket: string): boolean {
  return /^[a-zA-Z0-9-]+$/.test(bucket);
}

/** Extracted-text refs are generated file names; never path-escape. */
function isValidTextRef(ref: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(ref);
}

function sessionFile(sessionsDir: string, id: string): string {
  if (!isValidSessionId(id)) throw new Error(`refusing unsafe session id: ${JSON.stringify(id)}`);
  return join(sessionsDir, `${id}.json`);
}

/**
 * Migrate a v1 session to the v2 shape (read-only compatibility).
 * The v1 file is NEVER rewritten; this is a companion read view.
 */
function migrateV1ToV2(v1: Session): SessionV2 {
  const date = v1.date ?? new Date(0).toISOString();
  const fragments: SessionFragmentV2[] = (v1.fragments ?? []).map((f) => ({
    id: f.id,
    text: f.text,
    attempts: (f.attempts ?? []).map((a) => ({
      text: a.text,
      words: [], // v1 has no word-level data
      score: a.score ?? 0,
      startedAt: "",
      durationMs: 0,
    })),
    passed: Boolean(f.passed),
  }));
  return {
    id: v1.id,
    status: "completed",
    createdAt: date,
    updatedAt: date,
    config: {
      topicPrompt: v1.question ?? "",
      level: normalizeLevel(v1.level),
      category: v1.category ?? "free",
      accent: DEFAULT_ACCENT,
      phonemes: [],
      contextFiles: [],
      settingsSnapshot: DEFAULT_SETTINGS_SNAPSHOT,
    },
    provider: v1.provider ?? "unknown",
    questions: [
      {
        q: v1.question ?? "",
        answer: v1.fullAnswer?.text ?? "",
        fragments,
        fullAttempt: null,
        eval: null,
      },
    ],
    title: fallbackTitle(v1.question ?? ""),
  };
}

/** Parse a raw session file into v2, migrating v1 files on the fly. */
function toSessionV2(raw: unknown): SessionV2 | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj.questions) && obj.config && typeof obj.config === "object") {
    const v2 = obj as unknown as SessionV2;
    if (typeof v2.title === "string" && v2.title.length > 0) return v2;
    const cfg = v2.config as SessionConfig;
    return { ...v2, title: fallbackTitle(cfg.topicPrompt ?? "") };
  }
  if (typeof obj.id === "string" && obj.id.length > 0) {
    return migrateV1ToV2(obj as unknown as Session);
  }
  return undefined;
}

/**
 * Group sessions by recency of `updatedAt` (local calendar days):
 * Today / Yesterday / Previous 7 Days / Older. Each group is sorted newest first.
 * Generic over the item shape so both full sessions and light summaries (109)
 * can be bucketed with the same logic.
 */
export function groupSessionsByRecency<T extends { updatedAt: string }>(sessions: T[], now: Date = new Date()): RecencyGroup<T>[] {
  const startOfToday = startOfDay(now).getTime();
  const startOfYesterday = startOfToday - 86_400_000;
  const startOfLast7 = startOfToday - 7 * 86_400_000;
  const groups: RecencyGroup<T>[] = [
    { key: "today", label: "Today", sessions: [] },
    { key: "yesterday", label: "Yesterday", sessions: [] },
    { key: "last7", label: "Previous 7 Days", sessions: [] },
    { key: "older", label: "Older", sessions: [] },
  ];
  for (const s of sessions) {
    const t = new Date(s.updatedAt).getTime();
    if (t >= startOfToday) groups[0].sessions.push(s);
    else if (t >= startOfYesterday) groups[1].sessions.push(s);
    else if (t >= startOfLast7) groups[2].sessions.push(s);
    else groups[3].sessions.push(s);
  }
  for (const g of groups) {
    g.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return groups;
}

/**
 * Average pronunciation score of a session across all fragment attempts
 * (same formula as the practice done-panel and `/api/history`). Returns null
 * when the session has no attempts yet.
 */
export function sessionScore(session: SessionV2): number | null {
  const scores = session.questions.flatMap((q) => q.fragments.flatMap((f) => f.attempts.map((a) => a.score)));
  return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
}

/**
 * Progress of a session: questions answered (eval set) vs total questions.
 * A fresh session (0 questions) reports 0/0 with pct 0.
 */
export function sessionProgress(session: SessionV2): SessionProgress {
  const total = session.questions.length;
  const answered = session.questions.filter((q) => q.eval !== null).length;
  return { answered, total, pct: total > 0 ? Math.round((answered / total) * 100) : 0 };
}

/**
 * Extract the light history summary from a raw session file (feature 109).
 * Migrates v1 files on the fly like `toSessionV2`; returns undefined for
 * unreadable/corrupt files so the listing can skip them defensively.
 */
export function toSessionSummary(raw: unknown): SessionSummary | undefined {
  const session = toSessionV2(raw);
  if (!session) return undefined;
  const score = sessionScore(session);
  return {
    id: session.id,
    title: session.title,
    level: session.config.level,
    provider: session.provider,
    status: session.status,
    updatedAt: session.updatedAt,
    ...(score !== null ? { score } : {}),
    progress: sessionProgress(session),
  };
}

export function createStorage(baseDir: string): Storage & {
  loadProfile(): Profile;
  saveProfile(profile: Profile): void;
  createSession(config: SessionConfig, opts?: CreateSessionOptions): string;
  saveSession(session: SessionV2): void;
  loadSession(id: string): SessionV2 | undefined;
  listSessions(opts?: ListSessionsOptions): SessionV2[];
  loadAllSessions(): SessionV2[];
  listSessionSummaries(opts?: ListSessionsOptions): SessionSummary[];
  deleteSession(id: string): boolean;
  copyContextText(fromBucket: string, toBucket: string, textRef: string): boolean;
  saveContextText(bucket: string, file: { name: string; size: number; kind: FileKind }, text: string): string;
  loadContextText(bucket: string, textRef: string): string | undefined;
} {
  const dataDir = join(baseDir, "data");
  const profilePath = join(dataDir, "profile.json");
  const sessionsDir = join(dataDir, "sessions");
  const tmpDir = join(dataDir, "tmp");
  mkdirp(sessionsDir);
  mkdirp(tmpDir);

  const storage: Storage = { dataDir, profilePath, sessionsDir, tmpDir };

  return {
    ...storage,
    loadProfile(): Profile {
      try {
        if (existsSync(profilePath)) {
          const parsed = JSON.parse(readFileSync(profilePath, "utf8")) as Partial<Profile>;
          return {
            level: normalizeLevel(parsed.level),
            categories: parsed.categories ?? {},
            weakErrors: parsed.weakErrors ?? {},
            vocabGaps: parsed.vocabGaps ?? [],
            recentTopics: parsed.recentTopics ?? [],
            ...(parsed.focusPhonemes ? { focusPhonemes: parsed.focusPhonemes } : {}),
            ...(parsed.lastSessionAt ? { lastSessionAt: parsed.lastSessionAt } : {}),
            ...(parsed.nextStep ? { nextStep: parsed.nextStep } : {}),
            ...(parsed.settings ? { settings: parsed.settings } : {}),
          };
        }
      } catch {
        // corrupt profile -> start fresh
      }
      return { level: "B1", categories: {}, weakErrors: {}, vocabGaps: [], recentTopics: [] };
    },
    saveProfile(profile: Profile): void {
      writeJSONAtomic(profilePath, profile);
    },
    /**
     * Create a new active session and persist it immediately.
     * Only called once the user presses "Iniciar práctica" (CU3): without a
     * config there is no session, so no file is ever written here otherwise.
     */
    createSession(config: SessionConfig, opts?: CreateSessionOptions): string {
      const id = randomUUID();
      const now = new Date().toISOString();
      const session: SessionV2 = {
        id,
        status: "active",
        createdAt: now,
        updatedAt: now,
        config,
        provider: opts?.provider ?? "unknown",
        questions: [],
        title: opts?.title?.trim() || fallbackTitle(config.topicPrompt),
      };
      writeJSONAtomic(join(sessionsDir, `${id}.json`), session);
      return id;
    },
    /**
     * Persist the full session state (idempotent: replaces the whole file,
     * never merges). Bumps `updatedAt` to now on every checkpoint save.
     */
    saveSession(session: SessionV2): void {
      if (!session.id) throw new Error("saveSession: session.id is required.");
      const file = sessionFile(this.sessionsDir, session.id);
      // Feature 102: a v1 file is a compatibility view and must NEVER be
      // rewritten; refuse to overwrite legacy files.
      if (existsSync(file)) {
        const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        if (!Array.isArray(raw.questions)) {
          throw new Error(`refusing to overwrite v1 session file: ${session.id}`);
        }
      }
      const now = new Date().toISOString();
      writeJSONAtomic(file, { ...session, updatedAt: now });
    },
    loadSession(id: string): SessionV2 | undefined {
      let file: string;
      try {
        file = sessionFile(this.sessionsDir, id);
      } catch {
        return undefined;
      }
      if (!existsSync(file)) return undefined;
      try {
        return toSessionV2(JSON.parse(readFileSync(file, "utf8")) as unknown);
      } catch {
        return undefined;
      }
    },
    listSessions(opts?: ListSessionsOptions): SessionV2[] {
      if (!existsSync(sessionsDir)) return [];
      let sessions = readdirSync(sessionsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          try {
            return toSessionV2(JSON.parse(readFileSync(join(sessionsDir, f), "utf8")) as unknown);
          } catch {
            return undefined;
          }
        })
        .filter((s): s is SessionV2 => s !== undefined);
      if (opts?.status) sessions = sessions.filter((s) => s.status === opts.status);
      if (opts?.since) sessions = sessions.filter((s) => s.updatedAt >= opts.since!);
      sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (opts?.limit && opts.limit > 0) sessions = sessions.slice(0, opts.limit);
      return sessions;
    },
    loadAllSessions(): SessionV2[] {
      return this.listSessions();
    },
    /**
     * Light history listing (feature 109): reads every session file but keeps
     * only the summary fields — never the topicPrompt or question bodies.
     * Same filtering/sorting contract as `listSessions`.
     */
    listSessionSummaries(opts?: ListSessionsOptions): SessionSummary[] {
      if (!existsSync(sessionsDir)) return [];
      let summaries = readdirSync(sessionsDir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          try {
            return toSessionSummary(JSON.parse(readFileSync(join(sessionsDir, f), "utf8")) as unknown);
          } catch {
            return undefined;
          }
        })
        .filter((s): s is SessionSummary => s !== undefined);
      if (opts?.status) summaries = summaries.filter((s) => s.status === opts.status);
      if (opts?.since) summaries = summaries.filter((s) => s.updatedAt >= opts.since!);
      summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      if (opts?.limit && opts.limit > 0) summaries = summaries.slice(0, opts.limit);
      return summaries;
    },
    /**
     * Delete a session file and its extracted-context bucket (feature 109).
     * Returns false when the session does not exist or the id is unsafe.
     */
    deleteSession(id: string): boolean {
      let file: string;
      try {
        file = sessionFile(this.sessionsDir, id);
      } catch {
        return false;
      }
      if (!existsSync(file)) return false;
      rmSync(file, { force: true });
      // Best-effort cleanup of the session's context texts (data/tmp/context/<id>).
      if (isValidBucket(id)) {
        rmSync(join(this.tmpDir, "context", id), { recursive: true, force: true });
      }
      return true;
    },
    /**
     * Copy an extracted context text from one bucket to another (feature 109
     * "Practicar de nuevo"): the new session must be self-contained, so its
     * context files are duplicated into its own bucket. Falls back to the
     * "draft" bucket like `loadContextText` (files uploaded before session
     * creation live there). Returns false when the text cannot be resolved.
     */
    copyContextText(fromBucket: string, toBucket: string, textRef: string): boolean {
      if (!isValidBucket(fromBucket) || !isValidBucket(toBucket) || !isValidTextRef(textRef)) return false;
      for (const candidate of [fromBucket, "draft"]) {
        const source = join(this.tmpDir, "context", candidate, textRef);
        if (!existsSync(source)) continue;
        const dir = join(this.tmpDir, "context", toBucket);
        mkdirp(dir);
        writeFileSync(join(dir, textRef), readFileSync(source, "utf8"), "utf8");
        return true;
      }
      return false;
    },
    /**
     * Persist extracted context text under `data/tmp/context/<bucket>/` and
     * return the generated `textRef` (feature 104). The bucket is a session id
     * or the "draft" bucket used before a session exists (CU1 dropzone).
     */
    saveContextText(bucket: string, file: { name: string; size: number; kind: FileKind }, text: string): string {
      if (!isValidBucket(bucket)) throw new Error(`refusing unsafe context bucket: ${JSON.stringify(bucket)}`);
      const dir = join(this.tmpDir, "context", bucket);
      mkdirp(dir);
      const textRef = `${file.kind}-${randomUUID()}.txt`;
      writeFileSync(join(dir, textRef), text, "utf8");
      return textRef;
    },
    /**
     * Read an extracted context text back. Falls back to the "draft" bucket so
     * files uploaded before session creation (CU1 dropzone) resolve seamlessly
     * once the session exists and `config.contextFiles[]` references them.
     */
    loadContextText(bucket: string, textRef: string): string | undefined {
      if (!isValidBucket(bucket) || !isValidTextRef(textRef)) return undefined;
      for (const candidate of [bucket, "draft"]) {
        const file = join(this.tmpDir, "context", candidate, textRef);
        if (!existsSync(file)) continue;
        try {
          return readFileSync(file, "utf8");
        } catch {
          return undefined;
        }
      }
      return undefined;
    },
  };
}