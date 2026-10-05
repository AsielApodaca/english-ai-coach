/**
 * Storage facade (features 102/103/104/105/108/109/117).
 *
 * Feature 117 split the 756-line module by responsibility; this file keeps the
 * public entry point every caller already imports:
 *
 *   - `createStorage(baseDir)` — the object with the four data paths and the
 *     load/save/copy/delete operations, each delegating to the module that
 *     owns it (profile, session, context).
 *   - `export * from ...` — the whole contract re-exported, so every caller
 *     goes through this single entry point (`lib/session/storage.ts`).
 *
 * The modules behind it:
 *
 *   - `session-types.ts`    — model: levels, v1/v2 session shapes, profile,
 *                             options, default constants, pure helpers.
 *   - `session-guards.ts`   — runtime guards: client-body validation
 *                             (`isAttemptWords`, `isSessionEval`) and the
 *                             id/bucket shape rules (`isValidSessionId`,
 *                             `isValidOptionalSessionId`, `isValidBucket`).
 *   - `storage-session.ts`  — session files: paths, v1→v2 migration, the
 *                             recency/status queries and the CRUD.
 *   - `storage-profile.ts`  — `data/profile.json` read/write.
 *   - `storage-context.ts`  — extracted context texts under `data/tmp/context`.
 *   - `json-file.ts`        — `ensureDir` + atomic JSON write primitives.
 */

import { join } from "node:path";

import { ensureDir } from "./json-file.ts";
import type {
  CreateSessionOptions,
  FileKind,
  ListSessionsOptions,
  Profile,
  SessionConfig,
  SessionSummary,
  SessionV2,
} from "./session-types.ts";
import { copyContextTextFile, readContextTextFile, writeContextTextFile } from "./storage-context.ts";
import { readProfileFile, writeProfileFile } from "./storage-profile.ts";
import {
  createSessionFile,
  deleteSessionFile,
  listSessionFiles,
  listSessionSummaryFiles,
  readSessionFile,
  writeSessionFile,
} from "./storage-session.ts";

/** The JSON files this app persists under `<baseDir>/data/`: profile, sessions, temp context texts. */
interface Storage {
  dataDir: string;
  profilePath: string;
  sessionsDir: string;
  tmpDir: string;
}

/**
 * Build the storage facade rooted at `<baseDir>/data`, creating
 * `data/sessions/` and `data/tmp/` when missing. Every method is a thin
 * delegation to the owning module — no logic lives here.
 */
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

  ensureDir(sessionsDir);
  ensureDir(tmpDir);

  const storage: Storage = { dataDir, profilePath, sessionsDir, tmpDir };

  return {
    ...storage,
    loadProfile: () => readProfileFile(profilePath),
    saveProfile: (profile: Profile) => writeProfileFile(profilePath, profile),
    createSession: (config, opts) => createSessionFile(sessionsDir, config, opts),
    saveSession: (session: SessionV2) => writeSessionFile(sessionsDir, session),
    loadSession: (id: string) => readSessionFile(sessionsDir, id),
    listSessions: (opts?: ListSessionsOptions) => listSessionFiles(sessionsDir, opts),
    loadAllSessions: () => listSessionFiles(sessionsDir),
    listSessionSummaries: (opts?: ListSessionsOptions) => listSessionSummaryFiles(sessionsDir, opts),
    deleteSession: (id: string) => deleteSessionFile(sessionsDir, tmpDir, id),
    copyContextText: (fromBucket: string, toBucket: string, textRef: string) =>
      copyContextTextFile(tmpDir, fromBucket, toBucket, textRef),
    saveContextText: (bucket: string, file: { name: string; size: number; kind: FileKind }, text: string) =>
      writeContextTextFile(tmpDir, bucket, file, text),
    loadContextText: (bucket: string, textRef: string) => readContextTextFile(tmpDir, bucket, textRef),
  };
}

export * from "./session-types.ts";
export * from "./session-guards.ts";
export * from "./storage-session.ts";
export * from "./storage-profile.ts";
export * from "./storage-context.ts";
