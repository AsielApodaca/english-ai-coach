/**
 * Client-body guards for the session model (feature 117).
 *
 * A `/api` JSON payload must match the type it is stored as, or the route
 * answers 400 `{ error }` — nothing is persisted from an unvalidated body.
 * Each exported guard is the runtime mirror of a type in `session-types.ts`;
 * `isValidSessionId` is the SAME criterion `sessionFile()` enforces (a
 * path-escaping id would throw 500 instead of failing validation with 400).
 */

import type { AttemptWord, FeedbackIssue, SessionEval, WordStatus } from "./session-types.ts";

// ---------------------------------------------------------------------------
// Client-body guards (feature 117): a /api JSON payload must match the type
// it is stored as, or the route answers 400 { error } — nothing is persisted
// from an unvalidated body.
// ---------------------------------------------------------------------------

function isWordStatus(v: unknown): v is WordStatus {
  return v === "green" || v === "amber" || v === "red";
}

/** `undefined` (absent) or a finite number — for the optional word timestamps. */
function isOptionalFiniteNumber(v: unknown): boolean {
  return v === undefined || (typeof v === "number" && Number.isFinite(v));
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((item) => typeof item === "string");
}

/** A FeedbackIssue value: known category, string message, optional string fix. */
function isFeedbackIssueValue(v: unknown): boolean {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const issue = v as Record<string, unknown>;
  const knownCategory =
    issue.category === "grammar" ||
    issue.category === "word-choice" ||
    issue.category === "fluency" ||
    issue.category === "pronunciation" ||
    issue.category === "other";
  return (
    knownCategory &&
    typeof issue.message === "string" &&
    (issue.fix === undefined || typeof issue.fix === "string")
  );
}

/**
 * Validate a client-supplied `AttemptWord[]` (e.g. `fullAttempt.words` of
 * `POST /api/session/checkpoint`, feature 117).
 *
 * Every element must be a non-null object matching the AttemptWord contract:
 * `word: string`, a traffic-light `status`, optional numeric `startMs`/`endMs`
 * (extra properties are tolerated). Non-arrays, arrays with junk entries,
 * `[{ text, startMs }]` (a WhisperWord shape without status) and null all
 * return false so the route can answer 400 instead of persisting them.
 */
export function isAttemptWords(v: unknown): v is AttemptWord[] {
  if (!Array.isArray(v)) return false;
  return v.every((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const w = item as Record<string, unknown>;
    return (
      typeof w.word === "string" &&
      isWordStatus(w.status) &&
      isOptionalFiniteNumber(w.startMs) &&
      isOptionalFiniteNumber(w.endMs)
    );
  });
}

/**
 * Type guard for `question.eval` (feature 117): `POST /api/session/checkpoint`
 * used to store `evalValue as SessionEval`, i.e. any object the client sent.
 * Now only the full SessionEval contract passes — numeric score, one of the
 * three verdicts, string arrays, FeedbackIssue objects and the boolean `next`.
 * `null`, arrays and partial objects return false → the route answers 400.
 */
export function isSessionEval(v: unknown): v is SessionEval {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.score === "number" &&
    Number.isFinite(e.score) &&
    (e.verdict === "great" || e.verdict === "almost" || e.verdict === "retry") &&
    isStringArray(e.matched) &&
    isStringArray(e.missing) &&
    isStringArray(e.extra) &&
    Array.isArray(e.issues) &&
    e.issues.every(isFeedbackIssueValue) &&
    isStringArray(e.tips) &&
    typeof e.next === "boolean"
  );
}

/**
 * Session ids are generated UUIDs; reject anything that could escape the
 * sessions dir. Exported (feature 117) so /api routes validate `sessionId`,
 * `fragmentId` and `id` with the SAME criterion `sessionFile()` enforces —
 * otherwise a malformed id throws (500) instead of failing validation (400).
 */
export function isValidSessionId(id: string): boolean {
  return /^[a-zA-Z0-9-]+$/.test(id);
}

/**
 * Validate an optional client-supplied session/fragment id (feature 117).
 *
 * Absent (undefined/null/"") is valid — it only means "do not persist".
 * Anything else must match `isValidSessionId` (the exact criterion
 * `sessionFile()` enforces): a path-escaping id would make
 * `loadSession`/`saveSession` throw (500) instead of failing validation (400).
 * Shared by `/api/evaluate`, `/api/attempt` and `/api/session/*`.
 */
export function isValidOptionalSessionId(v: unknown): boolean {
  if (v === undefined || v === null || v === "") return true;
  return typeof v === "string" && isValidSessionId(v);
}

/**
 * Context buckets are session ids or the pre-session "draft" bucket
 * (feature 104/109): a crafted bucket must never escape
 * `data/tmp/context/`. Shared by the context writer and
 * `deleteSessionFile` (cleanup) so both use the SAME criterion.
 */
export function isValidBucket(bucket: string): boolean {
  return /^[a-zA-Z0-9-]+$/.test(bucket);
}
