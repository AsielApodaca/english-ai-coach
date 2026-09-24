// ---------------------------------------------------------------------------
// CU2 practice state machine (feature 105) — pure, side-effect free.
//
// Models the karaoke practice flow of use case CU2 as a deterministic state
// machine driven by TTS/STT events. The view (public/ui/practice-view.js) is
// the effectful layer: it speaks, records and calls the API, then dispatches
// events into this reducer. Keeping the reducer pure makes the transitions
// unit-testable without audio, network or DOM.
//
// Phases:
//   intro → question → model → explaining → repeatingFragment → feedback
//        → fullAnswer → done
//
// The LOOP (repeatingFragment ↔ feedback) runs once per fragment; a failed
// attempt (score < passThreshold) retries the same fragment. After the last
// fragment passes, the flow moves to the full answer, and after it passes the
// session is done.
// ---------------------------------------------------------------------------

export type PracticePhase =
  | "intro"
  | "question"
  | "model"
  | "explaining"
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
  | { type: "RECORD_START" }
  | { type: "RECORD_END" }
  | { type: "ATTEMPT_RESULT"; outcome: AttemptOutcome }
  | { type: "RETRY" }
  | { type: "SKIP" }
  | { type: "FINISH" }
  | { type: "EXIT" }
  | { type: "TIMEOUT"; target: string }
  | { type: "ERROR"; message: string };

/** Create the initial practice state (intro phase, coach starts speaking). */
export function initialPracticeState(fragmentCount: number): PracticeState {
  return {
    phase: "intro",
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
      return { ...base, phase: "intro", ttsSpeaking: true, waitingForUser: false, error: null };

    case "TTS_START":
      return { ...base, ttsSpeaking: true };

    case "TTS_END":
      return onTtsEnd(base);

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

/** TTS_END transitions: the coach finished speaking → next phase. */
function onTtsEnd(state: PracticeState): PracticeState {
  switch (state.phase) {
    case "intro":
      return { ...state, phase: "question", ttsSpeaking: false };
    case "question":
      return { ...state, phase: "model", ttsSpeaking: false };
    case "model":
      return { ...state, phase: "explaining", ttsSpeaking: false };
    case "explaining":
      return {
        ...state,
        phase: "repeatingFragment",
        fragmentIndex: 0,
        attemptCount: 0,
        ttsSpeaking: false,
        waitingForUser: true,
        timeoutCount: 0,
      };
    case "repeatingFragment":
      // Coach finished reading the fragment → hand over to the user.
      return { ...state, ttsSpeaking: false, waitingForUser: true, timeoutCount: 0 };
    case "feedback":
      return onFeedbackTtsEnd(state);
    case "fullAnswer":
      // Coach finished the full-answer instruction → user reads it.
      return { ...state, ttsSpeaking: false, waitingForUser: true, timeoutCount: 0 };
    default:
      return state;
  }
}

/** After the coach's spoken feedback: advance, retry or finish. */
function onFeedbackTtsEnd(state: PracticeState): PracticeState {
  const last = state.lastAttempt;
  if (!last) {
    return { ...state, phase: "repeatingFragment", ttsSpeaking: false, waitingForUser: true, timeoutCount: 0 };
  }
  if (last.kind === "full") {
    if (last.passed) {
      return { ...state, phase: "done", ttsSpeaking: false, waitingForUser: false };
    }
    // Full answer failed → retry the full answer.
    return { ...state, phase: "fullAnswer", ttsSpeaking: false, waitingForUser: true, timeoutCount: 0 };
  }
  if (last.passed) {
    if (state.fragmentIndex + 1 < state.fragmentCount) {
      return {
        ...state,
        phase: "repeatingFragment",
        fragmentIndex: state.fragmentIndex + 1,
        attemptCount: 0,
        ttsSpeaking: false,
        waitingForUser: true,
        timeoutCount: 0,
      };
    }
    return { ...state, phase: "fullAnswer", ttsSpeaking: false, waitingForUser: true, timeoutCount: 0 };
  }
  // Fragment failed → retry the same fragment (CU2 alt flow).
  return { ...state, phase: "repeatingFragment", ttsSpeaking: false, waitingForUser: true, timeoutCount: 0 };
}

/** ATTEMPT_RESULT: record the outcome and move to the feedback phase. */
function onAttemptResult(state: PracticeState, outcome: AttemptOutcome): PracticeState {
  if (state.phase === "repeatingFragment") {
    const passedFragments = outcome.passed
      ? [...new Set([...state.passedFragments, state.fragmentIndex])]
      : state.passedFragments;
    return {
      ...state,
      phase: "feedback",
      lastAttempt: outcome,
      attemptCount: state.attemptCount + 1,
      passedFragments,
      ttsSpeaking: true,
      waitingForUser: false,
      recording: false,
      timeoutCount: 0,
    };
  }
  if (state.phase === "fullAnswer") {
    return {
      ...state,
      phase: "feedback",
      lastAttempt: outcome,
      fullAttemptCount: state.fullAttemptCount + 1,
      fullPassed: outcome.passed || state.fullPassed,
      ttsSpeaking: true,
      waitingForUser: false,
      recording: false,
      timeoutCount: 0,
    };
  }
  return state;
}

/** TIMEOUT guard: no speech detected while waiting → failed attempt + retry. */
function onTimeout(state: PracticeState, target: string): PracticeState {
  if (!state.waitingForUser || state.recording) return state;
  const timeoutCount = state.timeoutCount + 1;
  if (state.phase !== "repeatingFragment" && state.phase !== "fullAnswer") {
    return { ...state, timeoutCount };
  }
  const outcome: AttemptOutcome = {
    kind: state.phase === "fullAnswer" ? "full" : "fragment",
    score: 0,
    verdict: "retry",
    passed: false,
    words: [],
    target,
    timedOut: true,
  };
  return onAttemptResult({ ...state, timeoutCount }, outcome);
}

// ---------------------------------------------------------------------------
// Helpers
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

// ---------------------------------------------------------------------------
// Spoken lines (served to the view via the session endpoints)
// ---------------------------------------------------------------------------

/** INTRO: opening speech — topic context + dynamics (CU2 step 1). */
export function buildIntroText(config: { topicPrompt: string; level: string }): string {
  return (
    "Welcome to your practice session. Here is how it works: I will ask you a question, " +
    "then I will show you a strong model answer. I will read it in short fragments, and you " +
    "repeat each one after me. I will give you feedback as we go. At the end, you will read " +
    "the whole answer out loud. Let's begin."
  );
}

/** EXPLAIN: coach explains the fragment dynamics (CU2 step 6). */
export function buildExplainLine(): string {
  return (
    "Now let's practice. I will read the answer in short fragments. Listen to each fragment, " +
    "then repeat it after me. Try to match my pronunciation. I will highlight the words you " +
    "need to work on."
  );
}

/** FULL: coach instructs the user to read the whole answer (CU2 step 14). */
export function buildFullLine(): string {
  return (
    "Great job! Now let's put it all together. Read the entire answer out loud, from start to " +
    "finish. I will highlight each word as you say it."
  );
}

/** Spoken feedback after an attempt (score + focused correction). */
export function buildFeedbackText(outcome: {
  score: number;
  passed: boolean;
  missing: string[];
  tips: string[];
}): string {
  if (outcome.passed) {
    const tip = outcome.tips[0] ? ` ${outcome.tips[0]}` : "";
    return `Great job! That was ${outcome.score} percent accurate.${tip}`;
  }
  const focus = outcome.missing.length
    ? ` Focus on: ${outcome.missing.slice(0, 3).join(", ")}.`
    : "";
  return `Almost there. That was ${outcome.score} percent. Let's try that again.${focus}`;
}

/** Default pass threshold when the session/config carries no override. */
export const DEFAULT_PASS_THRESHOLD = 70;

/** Read the pass threshold from a session config snapshot (feature 108). */
export function readPassThreshold(settingsSnapshot?: { overrides?: Record<string, unknown> }): number {
  const value = settingsSnapshot?.overrides?.passThreshold;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : DEFAULT_PASS_THRESHOLD;
}