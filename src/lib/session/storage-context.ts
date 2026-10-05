/**
 * Extracted context-text persistence (feature 104) — split out of `storage.ts`
 * by feature 117. Texts live under `data/tmp/context/<bucket>/<textRef>`, the
 * bucket being a session id or the pre-session `draft` bucket; every path
 * component is validated so a crafted id can never escape that directory.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { ensureDir } from "./json-file.ts";
import { isValidBucket } from "./session-guards.ts";
import type { FileKind } from "./session-types.ts";

/** Extracted-text refs are generated file names; never path-escape. */
function isValidTextRef(ref: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(ref);
}

/**
 * Copy an extracted context text from one bucket to another (feature 109
 * "Practicar de nuevo"): the new session must be self-contained, so its
 * context files are duplicated into its own bucket. Falls back to the
 * "draft" bucket like `loadContextText` (files uploaded before session
 * creation live there). Returns false when the text cannot be resolved.
 */
export function copyContextTextFile(tmpDir: string, fromBucket: string, toBucket: string, textRef: string): boolean {
  if (!isValidBucket(fromBucket) || !isValidBucket(toBucket) || !isValidTextRef(textRef)) return false;
  for (const candidate of [fromBucket, "draft"]) {
    const source = join(tmpDir, "context", candidate, textRef);
    if (!existsSync(source)) continue;
    const dir = join(tmpDir, "context", toBucket);
    ensureDir(dir);
    writeFileSync(join(dir, textRef), readFileSync(source, "utf8"), "utf8");
    return true;
  }
  return false;
}

/**
 * Persist extracted context text under `data/tmp/context/<bucket>/` and
 * return the generated `textRef` (feature 104). The bucket is a session id
 * or the "draft" bucket used before a session exists (CU1 dropzone).
 */
export function writeContextTextFile(tmpDir: string, bucket: string, file: { name: string; size: number; kind: FileKind }, text: string): string {
  if (!isValidBucket(bucket)) throw new Error(`refusing unsafe context bucket: ${JSON.stringify(bucket)}`);
  const dir = join(tmpDir, "context", bucket);
  ensureDir(dir);
  const textRef = `${file.kind}-${randomUUID()}.txt`;
  writeFileSync(join(dir, textRef), text, "utf8");
  return textRef;
}

/**
 * Read an extracted context text back. Falls back to the "draft" bucket so
 * files uploaded before session creation (CU1 dropzone) resolve seamlessly
 * once the session exists and `config.contextFiles[]` references them.
 */
export function readContextTextFile(tmpDir: string, bucket: string, textRef: string): string | undefined {
  if (!isValidBucket(bucket) || !isValidTextRef(textRef)) return undefined;
  for (const candidate of [bucket, "draft"]) {
    const file = join(tmpDir, "context", candidate, textRef);
    if (!existsSync(file)) continue;
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  }
  return undefined;
}