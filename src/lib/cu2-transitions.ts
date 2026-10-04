/**
 * Private transition handlers of the CU2 reducer (feature 105) — split out of
 * `cu2.ts` by feature 117 so `cu2-state.ts` stays the readable model file.
 *
 * Each function takes the "base" state (already stamped with updatedAt) plus
 * whatever the event carried, and returns the next state. Called only by
 * `reducePractice` — that is why the four handlers `reducePractice`
 * dispatches to are exported; `onFeedbackTtsEnd` stays module-private.
 */

import type { AttemptOutcome, PracticeState } from "./cu2-state.ts";

/** TTS_END transitions: the coach finished speaking → next phase. */
export function onTtsEnd(state: PracticeState): PracticeState {
  switch (state.phase) {
    case "question":
      return { ...state, phase: "model", ttsSpeaking: false };
    case "model":
      // Feature 115: the model answer hands over DIRECTLY to the first
      // fragment — no spoken explanation of the dynamics in between (the
      // active fragment is highlighted visually instead).
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
      // Feature 110: a PASS no longer speaks a coach line — the view plays a
      // chime and CHIME_END is what advances the flow. TTS_END on a passed
      // attempt is therefore a deliberate no-op fallback (a stray or legacy
      // spoken line must not double-advance the flow); only the FAIL path
      // (spoken feedback → retry) still advances on TTS_END.
      if (state.lastAttempt?.passed) return state;
      return onFeedbackTtsEnd(state);
    case "fullAnswer":
      // Coach finished the full-answer instruction → user reads it.
      return { ...state, ttsSpeaking: false, waitingForUser: true, timeoutCount: 0 };
    default:
      return state;
  }
}

/**
 * CHIME_END (feature 110): the success chime of a PASSED attempt finished →
 * the same advance/finish transitions the spoken feedback used to drive.
 */
export function onChimeEnd(state: PracticeState): PracticeState {
  if (state.phase !== "feedback") return state;
  return onFeedbackTtsEnd(state);
}

/**
 * The feedback transitions: advance on pass, retry on fail, finish after a
 * passing full answer. Runs on CHIME_END (pass) and on TTS_END (fail: the
 * coach just spoke the correction).
 */
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
export function onAttemptResult(state: PracticeState, outcome: AttemptOutcome): PracticeState {
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
export function onTimeout(state: PracticeState, target: string): PracticeState {
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
