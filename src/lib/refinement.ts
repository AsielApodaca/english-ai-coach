// ---------------------------------------------------------------------------
// Attempt refinement (feature 116) — the background LLM pass of a fast attempt.
//
// `POST /api/attempt` answers as soon as whisper + the deterministic alignment
// are done (score/passed were already deterministic), and launches the LLM
// refinement in background. The refinement is registered under a random
// `attemptId` and served by `GET /api/attempt/:id/feedback`, a long-poll over
// the in-memory registry:
//
//   resolves  → { refined: true, issues, tips, verdict, score, next,
//                 coachLine, words (re-aligned with forced amber), provider }
//   rejects   → { refined: false }   (every LLM provider is down)
//   timeout   → { refined: false }   (server cap, REFINE_TIMEOUT_MS ~20 s)
//   unknown   → 404 { error }        (never registered, or TTL-purged)
//
// The registry is TTL-purged on access (60 s) and capped, so a long practice
// session can never grow it without bound. The pure pieces live here so the
// merge (naturalness → combined score, verdict, forced-amber re-alignment,
// coach line) is unit-testable without HTTP, network or storage.
// ---------------------------------------------------------------------------

import { alignTextWords, alignWords, forcedAmberWordsFromIssues } from "./align.ts";
import { buildFeedbackText } from "./cu2.ts";
import { updateProfile } from "./learner.ts";
import { evaluateFragmentDeterministic, isFiller, mergeLLMFeedback, normalize, refineWithLLM } from "./practice.ts";
import { MS_PER_MIN } from "./time.ts";
import type { AttemptStorage } from "./attempt-persist.ts";
import type { Candidate, Evaluation } from "./practice.ts";
import type { AttemptWord, FeedbackIssue, Level } from "./storage.ts";
import type { WhisperWord } from "./whisper.ts";

// ---------------------------------------------------------------------------
// The refinement itself
// ---------------------------------------------------------------------------

/** What the LLM refinement adds on top of the fast, deterministic response. */
export interface AttemptRefinement {
  /** Derived + LLM issues (LLM first-come order preserved, capped at 5). */
  issues: FeedbackIssue[];
  tips: string[];
  verdict: Evaluation["verdict"];
  /** Combined score: 0.75·lexical + 0.25·naturalness (the pre-116 score). */
  score: number;
  next: boolean;
  /** Coach line rebuilt with the REAL tips (buildFeedbackText, cu2.ts). */
  coachLine: string;
  /** Words re-aligned with the forced-amber set of the refined issues. */
  words: AttemptWord[];
  /** Provider that produced the refinement. */
  provider: string;
}

export interface RefineAttemptParams {
  target: string;
  userText: string;
  question: string;
  level: Level;
  /** Word-timestamped transcription; empty for text-mode attempts. */
  spokenWords: WhisperWord[];
  /** Pass decision of the fast response (align score vs pass threshold). */
  passed: boolean;
  /**
   * Session pass threshold the fast response used; the merged `verdict`/`next`
   * must agree with that decision (feature 117). Absent → DEFAULT_PASS_THRESHOLD.
   */
  passThreshold?: number;
  /**
   * Hook run after a successful refinement — e.g. patching `question.eval` of
   * a full attempt (`patchFullEval` below). Guarded here: a throwing hook can
   * never break the refinement nor the long-poll that awaits it.
   */
  onRefined?: (merged: Evaluation) => void;
}

/**
 * Run the LLM refinement of one attempt (feature 116): merge the feedback into
 * the deterministic word match, re-align the spoken words with the forced-amber
 * words the refined issues imply, and rebuild the coach line with the real
 * tips. REJECTS when every provider fails — that rejection is what the
 * long-poll turns into `{ refined: false }`.
 *
 * `alignScore`/`forcedAmber` note: forced amber only downgrades colors, never
 * matched/missing/extra, so the re-aligned score and coach line match the fast
 * response exactly — only the colors (and the tips in a passing line) move.
 */
export async function refineAttempt(candidates: Candidate[], params: RefineAttemptParams): Promise<AttemptRefinement> {
  const { lexical } = evaluateFragmentDeterministic({ target: params.target, userText: params.userText });
  const { feedback, provider } = await refineWithLLM(candidates, params);
  const merged = mergeLLMFeedback(lexical, feedback, { passThreshold: params.passThreshold });

  const forcedAmberWords = forcedAmberWordsFromIssues(merged.issues, params.target);
  const aligned =
    params.spokenWords.length > 0
      ? alignWords(params.spokenWords, params.target, { forcedAmberWords })
      : alignTextWords(params.userText, params.target);
  const addedWords = [...new Set(aligned.extra.map((w) => normalize(w)).filter((w) => w.length > 0 && !isFiller(w)))];
  const coachLine = buildFeedbackText({
    score: aligned.score,
    passed: params.passed,
    missing: aligned.missing,
    extra: addedWords,
    tips: merged.tips,
  });

  if (params.onRefined) {
    try {
      params.onRefined(merged);
    } catch {
      // Persistence must never break the refinement nor its long-poll (116).
    }
  }

  return {
    issues: merged.issues,
    tips: merged.tips,
    verdict: merged.verdict,
    score: merged.score,
    next: merged.next,
    coachLine,
    words: aligned.words,
    provider,
  };
}

// ---------------------------------------------------------------------------
// Patching the durable eval of a FULL attempt
// ---------------------------------------------------------------------------

/**
 * Patch `question.eval` of a FULL attempt with the refined evaluation (116).
 *
 * The fast response persists the DURABLE deterministic eval first, so the
 * review panel has something even when the LLM is down; when the refinement
 * lands, the LLM-owned fields move to their pre-116 values (combined score,
 * verdict, tips, derived+LLM issues). `next` keeps the align-based pass
 * decision written by `persistAttempt` — the pass/fail flow never re-reads it
 * and must stay byte-identical to the synchronous behaviour.
 *
 * The profile is recomputed right after the patch (same aggregation as
 * `persistAttempt`): `computeStats` reads `q.eval.issues` for `weakErrors`
 * (learner.ts), so without it the learner memory would keep the fast
 * evaluation's derived-only issues until some future attempt persisted.
 * Wrapped in try/catch (here and again in `refineAttempt`): persistence must
 * never break the response nor the long-poll awaiting the refinement.
 *
 * @param storage - session/profile persistence surface (createStorage)
 * @param sessionId - session of the attempt; absent → no-op
 * @param isFull - true only when the attempt was persisted as the full answer
 * @param merged - the refined evaluation to write onto `question.eval`
 */
export function patchFullEval(storage: AttemptStorage, sessionId: string | undefined, isFull: boolean, merged: Evaluation): void {
  if (!isFull || !sessionId) return;
  try {
    const session = storage.loadSession(sessionId);
    if (!session) return;
    const question = session.questions.at(-1);
    if (!question?.eval) return;
    question.eval = {
      ...question.eval,
      score: merged.score,
      verdict: merged.verdict,
      issues: merged.issues,
      tips: merged.tips,
    };
    storage.saveSession(session);
    const profile = storage.loadProfile();
    updateProfile(profile, storage.loadAllSessions());
    storage.saveProfile(profile);
  } catch {
    // v1 session file or disk error: the refinement itself must still land.
  }
}

// ---------------------------------------------------------------------------
// In-memory registry (TTL + cap) behind the long-poll endpoint
// ---------------------------------------------------------------------------

/** One registered refinement: its promise and the instant it expires. */
export interface RefinementEntry {
  promise: Promise<AttemptRefinement>;
  /** `now() + ttlMs` at registration; purged on the next access after it. */
  expiresAt: number;
}

export interface RefinementRegistry {
  /** Register a refinement (purges expired entries and enforces the cap). */
  set(id: string, promise: Promise<AttemptRefinement>): void;
  /** Look up a live entry (purges expired entries first); undefined if gone. */
  get(id: string): RefinementEntry | undefined;
}

/** Entries older than this are dropped on access (spec 116: ~60 s). */
export const REFINEMENT_TTL_MS = MS_PER_MIN;
/** Hard ceiling on registry entries (oldest dropped first). */
export const REFINEMENT_MAX_ENTRIES = 100;
/** Server long-poll cap for `GET /api/attempt/:id/feedback` (env override). */
export const DEFAULT_REFINE_TIMEOUT_MS = 20_000;

/**
 * Create the refinement registry of `POST /api/attempt`.
 *
 * @param opts.ttlMs time-to-live of an entry, measured from registration
 * @param opts.maxEntries hard cap; the oldest entry is dropped when reached
 * @param opts.now clock (injectable for tests)
 */
export function createRefinementRegistry(
  opts?: { ttlMs?: number; maxEntries?: number; now?: () => number },
): RefinementRegistry {
  const ttlMs = opts?.ttlMs ?? REFINEMENT_TTL_MS;
  const maxEntries = Math.max(1, opts?.maxEntries ?? REFINEMENT_MAX_ENTRIES);
  const now = opts?.now ?? Date.now;
  const entries = new Map<string, RefinementEntry>();

  /** Drop every expired entry (called on both set and get — purge on access). */
  const purge = (): void => {
    const t = now();
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= t) entries.delete(id);
    }
  };

  return {
    set(id, promise) {
      purge();
      // Cap: Map preserves insertion order, so the first key is the oldest.
      while (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      entries.set(id, { promise, expiresAt: now() + ttlMs });
    },
    get(id) {
      purge();
      return entries.get(id);
    },
  };
}

// ---------------------------------------------------------------------------
// Long-poll
// ---------------------------------------------------------------------------

export type RefinementWaitResult =
  | { status: "refined"; refinement: AttemptRefinement }
  | { status: "failed" }
  | { status: "timeout" };

/**
 * Await a registered refinement with a server-side cap. Resolves "refined"
 * when the promise fulfils, "failed" when it rejects (LLM chain down) and
 * "timeout" after `timeoutMs` — the timer is always cleared, so a settled
 * wait leaks no handle; this never rejects.
 *
 * @param entry registry entry (already looked up; TTL not re-checked here)
 * @param timeoutMs maximum wait in ms
 */
export async function awaitRefinement(entry: RefinementEntry, timeoutMs: number): Promise<RefinementWaitResult> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const settled = entry.promise.then(
      (refinement): RefinementWaitResult => ({ status: "refined", refinement }),
      (): RefinementWaitResult => ({ status: "failed" }),
    );
    const capped = new Promise<RefinementWaitResult>((resolve) => {
      timer = setTimeout(() => resolve({ status: "timeout" }), timeoutMs);
    });
    return await Promise.race([settled, capped]);
  } finally {
    clearTimeout(timer);
  }
}

export interface AttemptFeedbackResponse {
  status: number;
  json: Record<string, unknown>;
}

/**
 * Handle `GET /api/attempt/:id/feedback` (feature 116) and return the HTTP
 * response, so the route stays a thin wrapper and the long-poll contract is
 * unit-testable without binding a port (same pattern as
 * `handleSessionStartRequest`).
 *
 * - unknown/expired id → 404 `{ error }`
 * - refinement settled → 200 `{ refined: true, ...refinement }`
 * - LLM rejected or wait capped → 200 `{ refined: false }` (the client keeps
 *   the deterministic state it already painted)
 */
export async function handleAttemptFeedbackRequest(
  registry: RefinementRegistry,
  id: string,
  timeoutMs: number,
): Promise<AttemptFeedbackResponse> {
  const entry = registry.get(id);
  if (!entry) return { status: 404, json: { error: "Unknown attempt id." } };
  const wait = await awaitRefinement(entry, timeoutMs);
  if (wait.status !== "refined") return { status: 200, json: { refined: false } };
  return { status: 200, json: { refined: true, ...wait.refinement } };
}
