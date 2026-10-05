/**
 * Atomic JSON file primitives (feature 117) shared by the storage modules:
 * the session, profile and context writers all need "temp file + rename" so
 * a crash mid-write can never leave a half-written file behind.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";

/** Ensure a directory exists (recursive, no error when it already does). */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Write file atomically: temp file + rename (avoids corruption on crash). */
export function writeJSONAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), "utf8");
  renameSync(tmp, file);
}
