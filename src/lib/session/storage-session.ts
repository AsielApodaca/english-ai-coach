/**
 * Session persistence (features 102/105/109) — split out of `storage.ts` by
 * feature 117: file paths and id safety, v1→v2 migration, the recency/status
 * queries and the CRUD every `createStorage()` method delegates to.
 *
 * Pure helpers (`groupSessionsByRecency`, `sessionScore`,
 * `sessionProgress`, `toSessionSummary`) take data and return data — the
 * only I/O here is the session file itself.
 */

import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { writeJSONAtomic } from "./json-file.ts";
import { isValidBucket, isValidSessionId } from "./session-guards.ts";
import {
  DEFAULT_ACCENT,
  DEFAULT_SETTINGS_SNAPSHOT,
  fallbackTitle,
  normalizeLevel,
  type CreateSessionOptions,
  type ListSessionsOptions,
  type RecencyGroup,
  type Session,
  type SessionConfig,
  type SessionFragmentV2,
  type SessionProgress,
  type SessionSummary,
  type SessionV2,
} from "./session-types.ts";

/** Start of the local calendar day for `d`. */
function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** On-disk path of a session file, refusing any id that could escape the dir. */
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

// ---------------------------------------------------------------------------
// Session files (create / read / update / delete)
// ---------------------------------------------------------------------------

/** Create a new active session and persist it immediately (CU3). */
export function createSessionFile(
  sessionsDir: string,
  config: SessionConfig,
  opts?: CreateSessionOptions,
): string {
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
}

/**
 * Persist the full session state (idempotent: replaces the whole file,
 * never merges). Bumps `updatedAt` to now on every checkpoint save.
 */
export function writeSessionFile(sessionsDir: string, session: SessionV2): void {
  if (!session.id) throw new Error("saveSession: session.id is required.");
  const file = sessionFile(sessionsDir, session.id);
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
}

export function readSessionFile(sessionsDir: string, id: string): SessionV2 | undefined {
  let file: string;
  try {
    file = sessionFile(sessionsDir, id);
  } catch {
    return undefined;
  }
  if (!existsSync(file)) return undefined;
  try {
    return toSessionV2(JSON.parse(readFileSync(file, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

export function listSessionFiles(sessionsDir: string, opts?: ListSessionsOptions): SessionV2[] {
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
}

/**
 * Light history listing (feature 109): reads every session file but keeps
 * only the summary fields — never the topicPrompt or question bodies.
 * Same filtering/sorting contract as `listSessionFiles`.
 */
export function listSessionSummaryFiles(
  sessionsDir: string,
  opts?: ListSessionsOptions,
): SessionSummary[] {
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
}

/**
 * Delete a session file and its extracted-context bucket (feature 109).
 * Returns false when the session does not exist and the id is unsafe.
 */
export function deleteSessionFile(sessionsDir: string, tmpDir: string, id: string): boolean {
  let file: string;
  try {
    file = sessionFile(sessionsDir, id);
  } catch {
    return false;
  }
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  // Best-effort cleanup of the session's context texts (data/tmp/context/<id>).
  if (isValidBucket(id)) {
    rmSync(join(tmpDir, "context", id), { recursive: true, force: true });
  }
  return true;
}
