import { test } from "node:test";
import assert from "node:assert/strict";
import {
  initialPracticeState,
  reducePractice,
  isOrbEnabled,
  currentTarget,
  buildIntroText,
  buildExplainLine,
  buildFullLine,
  buildFeedbackText,
  DEFAULT_PASS_THRESHOLD,
  readPassThreshold,
  type AttemptOutcome,
  type PracticePhase,
  type PracticeState,
} from "../src/lib/cu2.ts";

/** A passing fragment attempt (score >= threshold). */
function passOutcome(kind: "fragment" | "full" = "fragment"): AttemptOutcome {
  return {
    kind,
    score: 92,
    verdict: "great",
    passed: true,
    words: [{ word: "hello", status: "green" }],
    target: "hello",
  };
}

/** A failing fragment attempt (score < threshold). */
function failOutcome(kind: "fragment" | "full" = "fragment"): AttemptOutcome {
  return {
    kind,
    score: 40,
    verdict: "retry",
    passed: false,
    words: [{ word: "hello", status: "red" }],
    target: "hello",
  };
}

/** Walk a state through a TTS_END chain and assert the final phase. */
function ttsChain(state: PracticeState, count: number): PracticeState {
  let s = state;
  for (let i = 0; i < count; i++) s = reducePractice(s, { type: "TTS_END" });
  return s;
}

// --- Initial state ----------------------------------------------------------

test("initialPracticeState: intro phase, coach speaking, orb disarmed", () => {
  const s = initialPracticeState(3);
  assert.equal(s.phase, "intro");
  assert.equal(s.fragmentCount, 3);
  assert.equal(s.fragmentIndex, 0);
  assert.equal(s.ttsSpeaking, true);
  assert.equal(s.waitingForUser, false);
  assert.equal(s.recording, false);
  assert.equal(isOrbEnabled(s), false);
});

// --- ENTER ------------------------------------------------------------------

test("ENTER: resets to intro and starts the coach speaking", () => {
  const s = reducePractice(initialPracticeState(2), { type: "ENTER" });
  assert.equal(s.phase, "intro");
  assert.equal(s.ttsSpeaking, true);
  assert.equal(s.error, null);
});

// --- TTS_END chain ----------------------------------------------------------

test("TTS_END chain: intro → question → model → explaining → repeatingFragment", () => {
  const s = ttsChain(initialPracticeState(2), 4);
  assert.equal(s.phase, "repeatingFragment");
  assert.equal(s.fragmentIndex, 0);
  assert.equal(s.waitingForUser, true);
  assert.equal(s.ttsSpeaking, false);
  assert.equal(isOrbEnabled(s), true);
});

test("TTS_END in repeatingFragment: hands over to the user (orb armed)", () => {
  const s = ttsChain(initialPracticeState(2), 5);
  assert.equal(s.phase, "repeatingFragment");
  assert.equal(s.waitingForUser, true);
  assert.equal(isOrbEnabled(s), true);
});

test("TTS_END in fullAnswer: hands over to the user", () => {
  let s = ttsChain(initialPracticeState(2), 4);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "TTS_END" }); // feedback → next fragment
  s = reducePractice(s, { type: "TTS_END" }); // fragment read → user
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "TTS_END" }); // feedback → fullAnswer
  assert.equal(s.phase, "fullAnswer");
  assert.equal(s.waitingForUser, true);
  assert.equal(isOrbEnabled(s), true);
});

// --- Recording --------------------------------------------------------------

test("RECORD_START only arms while waiting for the user", () => {
  const s = ttsChain(initialPracticeState(2), 4);
  const recording = reducePractice(s, { type: "RECORD_START" });
  assert.equal(recording.recording, true);
  assert.equal(recording.waitingForUser, false);
  assert.equal(isOrbEnabled(recording), false);

  // Ignored outside waiting phases.
  const intro = reducePractice(initialPracticeState(2), { type: "RECORD_START" });
  assert.equal(intro.recording, false);
});

test("RECORD_END clears the recording flag", () => {
  const s = ttsChain(initialPracticeState(2), 4);
  const r = reducePractice(reducePractice(s, { type: "RECORD_START" }), { type: "RECORD_END" });
  assert.equal(r.recording, false);
});

// --- Fragment attempts ------------------------------------------------------

test("ATTEMPT_RESULT (fragment passed): feedback phase, fragment marked passed", () => {
  const s = ttsChain(initialPracticeState(3), 4);
  const r = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  assert.equal(r.phase, "feedback");
  assert.equal(r.attemptCount, 1);
  assert.deepEqual(r.passedFragments, [0]);
  assert.equal(r.lastAttempt?.score, 92);
  assert.equal(r.ttsSpeaking, true); // coach speaks the feedback
});

test("feedback TTS_END (passed): advances to the next fragment", () => {
  let s = ttsChain(initialPracticeState(3), 4);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "TTS_END" });
  assert.equal(s.phase, "repeatingFragment");
  assert.equal(s.fragmentIndex, 1);
  assert.equal(s.attemptCount, 0);
  assert.equal(s.waitingForUser, true);
});

test("feedback TTS_END (passed, last fragment): moves to fullAnswer", () => {
  let s = ttsChain(initialPracticeState(1), 4);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "TTS_END" });
  assert.equal(s.phase, "fullAnswer");
  assert.equal(s.waitingForUser, true);
});

test("feedback TTS_END (failed): retries the SAME fragment (CU2 alt flow)", () => {
  let s = ttsChain(initialPracticeState(3), 4);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: failOutcome() });
  s = reducePractice(s, { type: "TTS_END" });
  assert.equal(s.phase, "repeatingFragment");
  assert.equal(s.fragmentIndex, 0); // unchanged
  assert.equal(s.waitingForUser, true);
});

// --- Full answer ------------------------------------------------------------

test("full answer passed → feedback → done", () => {
  let s = ttsChain(initialPracticeState(1), 4);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "TTS_END" }); // → fullAnswer
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome("full") });
  assert.equal(s.phase, "feedback");
  assert.equal(s.fullAttemptCount, 1);
  assert.equal(s.fullPassed, true);
  s = reducePractice(s, { type: "TTS_END" });
  assert.equal(s.phase, "done");
  assert.equal(s.waitingForUser, false);
});

test("full answer failed → feedback → retries the full answer (not a fragment)", () => {
  let s = ttsChain(initialPracticeState(1), 4);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "TTS_END" }); // → fullAnswer
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: failOutcome("full") });
  s = reducePractice(s, { type: "TTS_END" });
  assert.equal(s.phase, "fullAnswer");
  assert.equal(s.fullAttemptCount, 1);
  assert.equal(s.fullPassed, false);
  assert.equal(s.waitingForUser, true);
});

// --- Timeout guard ----------------------------------------------------------

test("TIMEOUT while waiting: failed attempt (score 0) + retry", () => {
  const s = ttsChain(initialPracticeState(2), 4);
  const r = reducePractice(s, { type: "TIMEOUT", target: "hello" });
  assert.equal(r.phase, "feedback");
  assert.equal(r.lastAttempt?.score, 0);
  assert.equal(r.lastAttempt?.passed, false);
  assert.equal(r.lastAttempt?.timedOut, true);
  // The attempt result closes the waiting phase → the counter resets.
  assert.equal(r.timeoutCount, 0);
});

test("TIMEOUT while recording: ignored (user is speaking)", () => {
  let s = ttsChain(initialPracticeState(2), 4);
  s = reducePractice(s, { type: "RECORD_START" });
  const r = reducePractice(s, { type: "TIMEOUT", target: "hello" });
  assert.equal(r.recording, true);
  assert.equal(r.lastAttempt, null);
});

test("TIMEOUT outside waiting phases: no-op (guard only fires while waiting)", () => {
  const s = initialPracticeState(2);
  const r = reducePractice(s, { type: "TIMEOUT", target: "hello" });
  assert.equal(r.phase, "intro");
  assert.equal(r.timeoutCount, 0);
  assert.equal(r.lastAttempt, null);
});

// --- SKIP / FINISH / EXIT / RETRY -------------------------------------------

test("SKIP: moves to the next fragment (or fullAnswer on the last one)", () => {
  let s = ttsChain(initialPracticeState(3), 4);
  s = reducePractice(s, { type: "SKIP" });
  assert.equal(s.phase, "repeatingFragment");
  assert.equal(s.fragmentIndex, 1);
  s = reducePractice(s, { type: "SKIP" });
  assert.equal(s.fragmentIndex, 2);
  s = reducePractice(s, { type: "SKIP" });
  assert.equal(s.phase, "fullAnswer");
});

test("FINISH: closes the session (done)", () => {
  const s = reducePractice(initialPracticeState(2), { type: "FINISH" });
  assert.equal(s.phase, "done");
  assert.equal(s.ttsSpeaking, false);
  assert.equal(s.waitingForUser, false);
});

test("EXIT: leaves the session active and resumable", () => {
  const s = reducePractice(initialPracticeState(2), { type: "EXIT" });
  assert.equal(s.exited, true);
  assert.equal(s.ttsSpeaking, false);
  assert.equal(s.recording, false);
});

test("RETRY: re-arms the current target from feedback", () => {
  let s = ttsChain(initialPracticeState(2), 4);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: failOutcome() });
  const r = reducePractice(s, { type: "RETRY" });
  assert.equal(r.phase, "repeatingFragment");
  assert.equal(r.waitingForUser, true);
  assert.equal(r.timeoutCount, 0);
});

test("ERROR: records the message without breaking the flow", () => {
  const s = reducePractice(initialPracticeState(2), { type: "ERROR", message: "boom" });
  assert.equal(s.error, "boom");
  assert.equal(s.phase, "intro");
});

// --- Helpers ----------------------------------------------------------------

test("isOrbEnabled: only true while waiting in repetition phases", () => {
  const s = ttsChain(initialPracticeState(2), 4);
  assert.equal(isOrbEnabled(s), true);
  const recording = reducePractice(s, { type: "RECORD_START" });
  assert.equal(isOrbEnabled(recording), false);
  const intro = initialPracticeState(2);
  assert.equal(isOrbEnabled(intro), false);
});

test("currentTarget: fragment text in repetition/feedback, answer in fullAnswer", () => {
  const question = {
    fragments: [{ text: "First fragment" }, { text: "Second fragment" }],
    answer: "The whole answer",
  };
  let s = ttsChain(initialPracticeState(2), 4);
  assert.equal(currentTarget(s, question), "First fragment");
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  assert.equal(currentTarget(s, question), "First fragment"); // feedback keeps the target
  s = reducePractice(s, { type: "TTS_END" });
  assert.equal(currentTarget(s, question), "Second fragment");
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "TTS_END" }); // → fullAnswer
  assert.equal(currentTarget(s, question), "The whole answer");
});

// --- Spoken lines -----------------------------------------------------------

test("buildIntroText: mentions the topic and the dynamics", () => {
  const text = buildIntroText({ topicPrompt: "Mock interview", level: "B2" });
  assert.match(text, /Welcome to your practice session/);
  assert.match(text, /repeat each one after me/);
});

test("buildExplainLine / buildFullLine: describe the fragment and full phases", () => {
  assert.match(buildExplainLine(), /short fragments/);
  assert.match(buildFullLine(), /entire answer out loud/);
});

test("buildFeedbackText: passed → positive with tip; failed → focus on missing", () => {
  const ok = buildFeedbackText({ score: 92, passed: true, missing: [], tips: ["Nice pacing."] });
  assert.match(ok, /92 percent/);
  assert.match(ok, /Nice pacing/);

  const fail = buildFeedbackText({ score: 40, passed: false, missing: ["situation", "handled"], tips: [] });
  assert.match(fail, /40 percent/);
  assert.match(fail, /situation, handled/);
  assert.match(fail, /try that again/);
});

// --- Pass threshold ---------------------------------------------------------

test("DEFAULT_PASS_THRESHOLD is 70", () => {
  assert.equal(DEFAULT_PASS_THRESHOLD, 70);
});

test("readPassThreshold: reads the override, falls back to default", () => {
  assert.equal(readPassThreshold(), 70);
  assert.equal(readPassThreshold({ overrides: {} }), 70);
  assert.equal(readPassThreshold({ overrides: { passThreshold: 80 } }), 80);
  assert.equal(readPassThreshold({ overrides: { passThreshold: "85" } }), 85);
  assert.equal(readPassThreshold({ overrides: { passThreshold: 0 } }), 70);
  assert.equal(readPassThreshold({ overrides: { passThreshold: -5 } }), 70);
});

test("readPassThreshold: non-finite/non-numeric overrides fall back, numbers round", () => {
  assert.equal(readPassThreshold({ overrides: { passThreshold: NaN } }), 70);
  assert.equal(readPassThreshold({ overrides: { passThreshold: Infinity } }), 70);
  assert.equal(readPassThreshold({ overrides: { passThreshold: "abc" } }), 70);
  assert.equal(readPassThreshold({ overrides: { passThreshold: null } }), 70);
  assert.equal(readPassThreshold({ overrides: { passThreshold: undefined } }), 70);
  assert.equal(readPassThreshold({ overrides: { passThreshold: 70.6 } }), 71);
});

// --- TTS_START --------------------------------------------------------------

test("TTS_START: marks the coach as speaking", () => {
  let s = ttsChain(initialPracticeState(2), 4); // waiting for the user
  s = reducePractice(s, { type: "TTS_START" });
  assert.equal(s.ttsSpeaking, true);
});

// --- Attempt chaining (internal retry) --------------------------------------

test("internal retry that passes: attemptCount chains, same fragment then advances", () => {
  let s = ttsChain(initialPracticeState(2), 4);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: failOutcome() });
  assert.equal(s.attemptCount, 1);
  assert.deepEqual(s.passedFragments, []);

  s = reducePractice(s, { type: "TTS_END" }); // feedback → retry the SAME fragment
  assert.equal(s.phase, "repeatingFragment");
  assert.equal(s.fragmentIndex, 0);

  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  assert.equal(s.attemptCount, 2); // both attempts counted on this fragment
  assert.deepEqual(s.passedFragments, [0]);

  s = reducePractice(s, { type: "TTS_END" });
  assert.equal(s.fragmentIndex, 1);
  assert.equal(s.attemptCount, 0); // counter resets for the next fragment
});

test("full answer chaining: fail → retry → pass → done (fullAttemptCount 2)", () => {
  let s = ttsChain(initialPracticeState(1), 4);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "TTS_END" }); // → fullAnswer
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: failOutcome("full") });
  assert.equal(s.fullAttemptCount, 1);
  assert.equal(s.fullPassed, false);
  s = reducePractice(s, { type: "TTS_END" }); // feedback → retry the full answer
  assert.equal(s.phase, "fullAnswer");
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome("full") });
  assert.equal(s.fullAttemptCount, 2);
  assert.equal(s.fullPassed, true);
  s = reducePractice(s, { type: "TTS_END" });
  assert.equal(s.phase, "done");
});

// --- Timeout guard edges ----------------------------------------------------

test("TIMEOUT in fullAnswer: failed FULL attempt (kind 'full')", () => {
  let s = ttsChain(initialPracticeState(1), 4);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "TTS_END" }); // → fullAnswer
  assert.equal(s.phase, "fullAnswer");
  const r = reducePractice(s, { type: "TIMEOUT", target: "The whole answer" });
  assert.equal(r.phase, "feedback");
  assert.equal(r.lastAttempt?.kind, "full");
  assert.equal(r.lastAttempt?.timedOut, true);
  assert.equal(r.lastAttempt?.passed, false);
  assert.equal(r.fullAttemptCount, 1);
  assert.equal(r.fullPassed, false);
});

test("TIMEOUT in a waiting non-repetition phase: only bumps timeoutCount (defensive)", () => {
  // The reducer only arms waitingForUser in repetition phases; this covers the
  // defensive branch against a stray guard timer elsewhere in the flow.
  const s: PracticeState = { ...initialPracticeState(2), phase: "question", waitingForUser: true };
  const r = reducePractice(s, { type: "TIMEOUT", target: "hello" });
  assert.equal(r.phase, "question");
  assert.equal(r.timeoutCount, 1);
  assert.equal(r.lastAttempt, null);
});

// --- No-op events (phase gates) ---------------------------------------------

test("ATTEMPT_RESULT outside repeatingFragment/fullAnswer: ignored", () => {
  const intro = reducePractice(initialPracticeState(2), { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  assert.equal(intro.phase, "intro");
  assert.equal(intro.attemptCount, 0);
  assert.equal(intro.lastAttempt, null);

  let s = ttsChain(initialPracticeState(2), 4);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: failOutcome() }); // → feedback
  const inFeedback = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  assert.equal(inFeedback.phase, "feedback");
  assert.equal(inFeedback.attemptCount, 1); // unchanged
  assert.equal(inFeedback.lastAttempt?.passed, false); // first outcome kept
});

test("RETRY from repeatingFragment: re-arms without changing the fragment", () => {
  const s = ttsChain(initialPracticeState(3), 4);
  const r = reducePractice(s, { type: "RETRY" });
  assert.equal(r.phase, "repeatingFragment");
  assert.equal(r.fragmentIndex, 0);
  assert.equal(r.waitingForUser, true);
  assert.equal(r.timeoutCount, 0);
});

test("RETRY from fullAnswer: re-arms the full answer", () => {
  let s = ttsChain(initialPracticeState(1), 4);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "TTS_END" }); // → fullAnswer
  const r = reducePractice(s, { type: "RETRY" });
  assert.equal(r.phase, "fullAnswer");
  assert.equal(r.waitingForUser, true);
  assert.equal(r.timeoutCount, 0);
});

test("RETRY outside feedback/repetition phases: no-op", () => {
  const s = reducePractice(initialPracticeState(2), { type: "RETRY" });
  assert.equal(s.phase, "intro");
  assert.equal(s.waitingForUser, false);
});

test("SKIP from feedback: advances like from repeatingFragment", () => {
  let s = ttsChain(initialPracticeState(3), 4);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: failOutcome() }); // → feedback
  const next = reducePractice(s, { type: "SKIP" });
  assert.equal(next.phase, "repeatingFragment");
  assert.equal(next.fragmentIndex, 1);
  assert.equal(next.attemptCount, 0);
  assert.equal(next.waitingForUser, true);

  // Last fragment: skip moves straight to the full answer.
  let last = ttsChain(initialPracticeState(1), 4);
  last = reducePractice(last, { type: "ATTEMPT_RESULT", outcome: failOutcome() });
  const full = reducePractice(last, { type: "SKIP" });
  assert.equal(full.phase, "fullAnswer");
  assert.equal(full.waitingForUser, true);
});

test("SKIP outside repetition phases: no-op (intro and fullAnswer)", () => {
  const intro = reducePractice(initialPracticeState(2), { type: "SKIP" });
  assert.equal(intro.phase, "intro");

  let full = ttsChain(initialPracticeState(1), 4);
  full = reducePractice(full, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  full = reducePractice(full, { type: "TTS_END" }); // → fullAnswer
  const r = reducePractice(full, { type: "SKIP" });
  assert.equal(r.phase, "fullAnswer"); // the full answer cannot be skipped
});

// --- EXIT leaves the session open -------------------------------------------

test("EXIT mid-practice: phase stays open (active, resumable)", () => {
  let s = ttsChain(initialPracticeState(3), 4);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "TTS_END" }); // fragment 1 waiting
  const r = reducePractice(s, { type: "EXIT" });
  assert.equal(r.exited, true);
  assert.equal(r.phase, "repeatingFragment"); // NOT done — the session stays open
  assert.equal(r.waitingForUser, false);
  assert.equal(r.recording, false);
  assert.equal(isOrbEnabled(r), false);
});

// --- ERROR recovery ---------------------------------------------------------

test("ERROR sticks across TTS_END until ENTER clears it (recovery)", () => {
  let s = reducePractice(initialPracticeState(2), { type: "ERROR", message: "boom" });
  s = reducePractice(s, { type: "TTS_END" });
  assert.equal(s.error, "boom");
  assert.equal(s.phase, "question"); // the flow keeps running
  s = reducePractice(s, { type: "ENTER" });
  assert.equal(s.error, null);
  assert.equal(s.phase, "intro");
});

// --- Defensive edges --------------------------------------------------------

test("TTS_END in done: no-op", () => {
  const s = reducePractice({ ...initialPracticeState(2), phase: "done" }, { type: "TTS_END" });
  assert.equal(s.phase, "done");
});

test("feedback TTS_END with no lastAttempt (defensive): back to repeatingFragment", () => {
  const s = reducePractice(
    { ...initialPracticeState(2), phase: "feedback", lastAttempt: null },
    { type: "TTS_END" },
  );
  assert.equal(s.phase, "repeatingFragment");
  assert.equal(s.fragmentIndex, 0);
  assert.equal(s.waitingForUser, true);
});

test("initialPracticeState clamps a negative fragmentCount to 0", () => {
  assert.equal(initialPracticeState(-3).fragmentCount, 0);
});

// --- Helpers (phase matrix) -------------------------------------------------

test("isOrbEnabled: true ONLY in repeatingFragment/fullAnswer while waiting", () => {
  const armedPhases: PracticePhase[] = ["repeatingFragment", "fullAnswer"];
  const otherPhases: PracticePhase[] = ["intro", "question", "model", "explaining", "feedback", "done"];
  for (const phase of armedPhases) {
    const s: PracticeState = { ...initialPracticeState(2), phase, waitingForUser: true };
    assert.equal(isOrbEnabled(s), true, `orb should be enabled in ${phase}`);
  }
  for (const phase of otherPhases) {
    // Even if waiting were somehow true, the phase gate keeps the orb off…
    const waiting: PracticeState = { ...initialPracticeState(2), phase, waitingForUser: true };
    assert.equal(isOrbEnabled(waiting), false, `orb must stay off in ${phase}`);
    // …and naturally when not waiting either.
    const idle: PracticeState = { ...initialPracticeState(2), phase, waitingForUser: false };
    assert.equal(isOrbEnabled(idle), false, `orb must stay off in ${phase} (idle)`);
  }
  // Recording while armed also disables the orb.
  const armed = ttsChain(initialPracticeState(2), 4);
  const recording = reducePractice(armed, { type: "RECORD_START" });
  assert.equal(isOrbEnabled(recording), false);
});

test('currentTarget: "" outside repetition phases; answer when fragmentIndex is out of range', () => {
  const question = {
    fragments: [{ text: "First fragment" }, { text: "Second fragment" }],
    answer: "The whole answer",
  };
  for (const phase of ["intro", "question", "model", "explaining", "done"] as const) {
    const s: PracticeState = { ...initialPracticeState(2), phase };
    assert.equal(currentTarget(s, question), "", `target must be empty in ${phase}`);
  }
  // Out-of-range index (defensive) → falls back to the full answer.
  const oob: PracticeState = {
    ...initialPracticeState(1),
    phase: "repeatingFragment",
    fragmentIndex: 5,
  };
  assert.equal(currentTarget(oob, question), "The whole answer");
});