/**
 * CU2 practice state (feature 105) — the phase/state/event model, the initial
 * state, the pure reducer entry point and the state queries the view derives
 * its controls from. Split out of `karaoke.ts` by feature 117; the private
 * transition handlers live in `karaoke-transitions.ts` and the spoken lines in
 * `karaoke-lines.ts`.
 *
 * Pure and side-effect free: no I/O, no timers — the caller owns the guard
 * timer and dispatches TIMEOUT when it fires.
 */

import { onAttemptResult, onChimeEnd, onTimeout, onTtsEnd } from "./karaoke-transitions.ts";

export type PracticePhase =
  | "question"
  | "model"
  | "repeatingFragment"
  | "feedback"
  | "fullAnswer"
  | "done";

export type WordStatus = "green" | "amber" | "red";
export type AttemptVerdict = "great" | "almost" | "retry";

/** One colored word of a spoken attempt (mirrors AttemptWord in storage.ts). */
export interface AttemptWord {
  word: string;
  status: WordStatus;
  startMs?: number;
  endMs?: number;
}

/** Result of a single spoken attempt (fragment or full answer). */
export interface AttemptOutcome {
  /** Whether the attempt targeted a fragment or the full answer. */
  kind: "fragment" | "full";
  score: number;
  verdict: AttemptVerdict;
  /** True when score >= passThreshold (decided by the caller). */
  passed: boolean;
  words: AttemptWord[];
  /** The text the user had to repeat. */
  target: string;
  /** True when the attempt came from the phase guard timeout (no speech). */
  timedOut?: boolean;
}

export interface PracticeState {
  phase: PracticePhase;
  /** Total number of fragments of the model answer. */
  fragmentCount: number;
  /** Index of the fragment currently being repeated (0-based). */
  fragmentIndex: number;
  /** Attempts made on the current fragment (retries included). */
  attemptCount: number;
  /** Indices of fragments that passed at least once. */
  passedFragments: number[];
  /** Last attempt outcome (drives the feedback phase). */
  lastAttempt: AttemptOutcome | null;
  /** Attempts made on the full answer. */
  fullAttemptCount: number;
  /** True once the full answer passed. */
  fullPassed: boolean;
  /** True while the coach audio is playing. */
  ttsSpeaking: boolean;
  /** True while the user is recording. */
  recording: boolean;
  /** True when the orb is armed and the user may speak. */
  waitingForUser: boolean;
  /** Number of guard timeouts accumulated in the current waiting phase. */
  timeoutCount: number;
  /** Last error message (non-fatal; the flow keeps running). */
  error: string | null;
  /** True when the user left the session (stays active, resumable). */
  exited: boolean;
  updatedAt: number;
}

export type PracticeEvent =
  | { type: "ENTER" }
  | { type: "TTS_START" }
  | { type: "TTS_END" }
  // Feature 110: the synthesized success chime ended. An explicit event (the
  // spec's preferred choice) instead of overloading TTS_END, which keeps its
  // literal meaning "the coach stopped speaking" for the spoken lines.
  | { type: "CHIME_END" }
  | { type: "RECORD_START" }
  | { type: "RECORD_END" }
  | { type: "ATTEMPT_RESULT"; outcome: AttemptOutcome }
  | { type: "RETRY" }
  | { type: "SKIP" }
  | { type: "FINISH" }
  | { type: "EXIT" }
  | { type: "TIMEOUT"; target: string }
  | { type: "ERROR"; message: string };

/** Create the initial practice state (question phase: coach reads the question). */
export function initialPracticeState(fragmentCount: number): PracticeState {
  return {
    phase: "question",
    fragmentCount: Math.max(0, fragmentCount),
    fragmentIndex: 0,
    attemptCount: 0,
    passedFragments: [],
    lastAttempt: null,
    fullAttemptCount: 0,
    fullPassed: false,
    ttsSpeaking: true,
    recording: false,
    waitingForUser: false,
    timeoutCount: 0,
    error: null,
    exited: false,
    updatedAt: Date.now(),
  };
}

/**
 * Reduce a practice event into the next state. Pure: no I/O, no timers — the
 * caller owns the guard timer and dispatches TIMEOUT when it fires.
 */
export function reducePractice(state: PracticeState, event: PracticeEvent): PracticeState {
  const base: PracticeState = { ...state, updatedAt: Date.now() };
  switch (event.type) {
    case "ENTER":
      return { ...base, phase: "question", ttsSpeaking: true, waitingForUser: false, error: null };

    case "TTS_START":
      return { ...base, ttsSpeaking: true };

    case "TTS_END":
      return onTtsEnd(base);

    case "CHIME_END":
      return onChimeEnd(base);

    case "RECORD_START":
      // The orb is only armed while waiting for the user.
      if (!state.waitingForUser) return base;
      return { ...base, recording: true, waitingForUser: false };

    case "RECORD_END":
      return { ...base, recording: false };

    case "ATTEMPT_RESULT":
      return onAttemptResult(base, event.outcome);

    case "RETRY":
      // Manual retry: re-arm the current target (fragment or full answer).
      if (state.phase === "feedback" || state.phase === "repeatingFragment") {
        return { ...base, phase: "repeatingFragment", ttsSpeaking: false, waitingForUser: true, timeoutCount: 0 };
      }
      if (state.phase === "fullAnswer") {
        return { ...base, phase: "fullAnswer", ttsSpeaking: false, waitingForUser: true, timeoutCount: 0 };
      }
      return base;

    case "SKIP":
      // Skip the current fragment (or the retry) and move forward.
      if (state.phase === "repeatingFragment" || state.phase === "feedback") {
        if (state.fragmentIndex + 1 < state.fragmentCount) {
          return {
            ...base,
            phase: "repeatingFragment",
            fragmentIndex: state.fragmentIndex + 1,
            attemptCount: 0,
            ttsSpeaking: false,
            waitingForUser: true,
            timeoutCount: 0,
          };
        }
        return { ...base, phase: "fullAnswer", ttsSpeaking: false, waitingForUser: true, timeoutCount: 0 };
      }
      return base;

    case "FINISH":
      return { ...base, phase: "done", ttsSpeaking: false, waitingForUser: false, recording: false };

    case "EXIT":
      // Leaving the session keeps it active (resumable, feature 109).
      return { ...base, exited: true, ttsSpeaking: false, waitingForUser: false, recording: false };

    case "TIMEOUT":
      return onTimeout(base, event.target);

    case "ERROR":
      return { ...base, error: event.message };
  }
}

// ---------------------------------------------------------------------------
// State queries (helpers)
// ---------------------------------------------------------------------------

/** True when the push-to-talk orb should be armed. */
export function isOrbEnabled(state: PracticeState): boolean {
  return (
    state.waitingForUser &&
    !state.recording &&
    (state.phase === "repeatingFragment" || state.phase === "fullAnswer")
  );
}

/** The text the user currently has to repeat (fragment or full answer). */
export function currentTarget(
  state: PracticeState,
  question: { fragments: Array<{ text: string }>; answer: string },
): string {
  if (state.phase === "fullAnswer") return question.answer;
  if (state.phase === "repeatingFragment" || state.phase === "feedback") {
    const fragment = question.fragments[state.fragmentIndex];
    return fragment ? fragment.text : question.answer;
  }
  return "";
}
