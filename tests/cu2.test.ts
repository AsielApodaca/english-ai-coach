import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as cu2 from "../src/lib/cu2.ts";
import {
  initialPracticeState,
  reducePractice,
  isOrbEnabled,
  currentTarget,
  buildFullLine,
  buildFeedbackText,
  buildNoSpeechText,
  DEFAULT_PASS_THRESHOLD,
  readPassThreshold,
  type AttemptOutcome,
  type PracticePhase,
  type PracticeState,
} from "../src/lib/cu2.ts";
import { buildSessionPayload } from "../src/lib/session-payload.ts";
import type { SessionV2 } from "../src/lib/storage.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
// Feature 117 split the reducer into cu2.ts (barrel) + cu2-state /
// cu2-transitions / cu2-lines. The "must be gone"/"authoritative union"
// checks below are about the MODULE as a whole, so they run over every file
// it is recomposed from — joined, the regexes see exactly the same code they
// saw when it lived in one file.
const reducerSrc = ["cu2.ts", "cu2-state.ts", "cu2-transitions.ts", "cu2-lines.ts"]
  .map((file) => readFileSync(join(repoRoot, "src", "lib", file), "utf8"))
  .join("\n");
const sessionRoutesSrc = readFileSync(join(repoRoot, "src", "lib", "routes", "session.ts"), "utf8");
const viewSrc = readFileSync(join(repoRoot, "public", "ui", "practice-view.js"), "utf8");

/**
 * Strip comments from source before running ABSENCE checks: the guarantees are
 * about the running code, so a prose comment quoting a removed identifier (e.g.
 * "data.intro was removed by 115") must not fail the suite. Naive by design and
 * safe for the two files it runs on: neither carries `//` inside string
 * literals, and JSDoc/block comments are the only multi-line comment form used.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/[^\n]*/gm, "$1");
}

/** Comment-free sources used by the "must be gone" checks of feature 115. */
const reducerCode = stripComments(reducerSrc);
const viewCode = stripComments(viewSrc);

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

/**
 * Minimal SessionV2 fixture for the payload contract (feature 115): the
 * snapshot carries explicit overrides so the threshold / auto-advance readers
 * are observable, and the stored question is a full v2 record.
 */
function payloadSession(): SessionV2 {
  return {
    id: "payload-contract-test",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    provider: "mock",
    title: "Payload contract",
    config: {
      topicPrompt: "Talk about a tricky bug.",
      level: "B2",
      category: "interviews",
      accent: "en-US",
      phonemes: [],
      contextFiles: [],
      settingsSnapshot: { version: 1, overrides: { passThreshold: 80, autoAdvance: true } },
    },
    questions: [
      {
        q: "What is a tricky bug you fixed?",
        answer: "I once fixed a race condition in our worker pool.",
        fragments: [{ id: "f1", text: "I once fixed", attempts: [], passed: false }],
        fullAttempt: null,
        eval: null,
      },
    ],
  };
}

// --- Initial state ----------------------------------------------------------

test("initialPracticeState: question phase, coach speaking, orb disarmed", () => {
  const s = initialPracticeState(3);
  assert.equal(s.phase, "question");
  assert.equal(s.fragmentCount, 3);
  assert.equal(s.fragmentIndex, 0);
  assert.equal(s.ttsSpeaking, true);
  assert.equal(s.waitingForUser, false);
  assert.equal(s.recording, false);
  assert.equal(isOrbEnabled(s), false);
});

// --- ENTER ------------------------------------------------------------------

test("ENTER: resets to the question phase and starts the coach speaking", () => {
  const s = reducePractice(initialPracticeState(2), { type: "ENTER" });
  assert.equal(s.phase, "question");
  assert.equal(s.ttsSpeaking, true);
  assert.equal(s.error, null);
});

// --- TTS_END chain ----------------------------------------------------------

test("TTS_END chain: question → model → repeatingFragment (direct, feature 115)", () => {
  // Two reads only: the model answer hands over straight to the first
  // fragment — there is no spoken explanation phase in between.
  const s = ttsChain(initialPracticeState(2), 2);
  assert.equal(s.phase, "repeatingFragment");
  assert.equal(s.fragmentIndex, 0);
  assert.equal(s.waitingForUser, true);
  assert.equal(s.ttsSpeaking, false);
  assert.equal(isOrbEnabled(s), true);
});

test("TTS_END in repeatingFragment: hands over to the user (orb armed)", () => {
  const s = ttsChain(initialPracticeState(2), 3);
  assert.equal(s.phase, "repeatingFragment");
  assert.equal(s.waitingForUser, true);
  assert.equal(isOrbEnabled(s), true);
});

test("TTS_END in fullAnswer: hands over to the user", () => {
  let s = ttsChain(initialPracticeState(2), 2);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "CHIME_END" }); // feedback → next fragment
  s = reducePractice(s, { type: "TTS_END" }); // fragment read → user
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "CHIME_END" }); // feedback → fullAnswer
  assert.equal(s.phase, "fullAnswer");
  assert.equal(s.waitingForUser, true);
  assert.equal(isOrbEnabled(s), true);
});

// --- Recording --------------------------------------------------------------

test("RECORD_START only arms while waiting for the user", () => {
  const s = ttsChain(initialPracticeState(2), 2);
  const recording = reducePractice(s, { type: "RECORD_START" });
  assert.equal(recording.recording, true);
  assert.equal(recording.waitingForUser, false);
  assert.equal(isOrbEnabled(recording), false);

  // Ignored outside waiting phases.
  const start = reducePractice(initialPracticeState(2), { type: "RECORD_START" });
  assert.equal(start.recording, false);
});

test("RECORD_END clears the recording flag", () => {
  const s = ttsChain(initialPracticeState(2), 2);
  const r = reducePractice(reducePractice(s, { type: "RECORD_START" }), { type: "RECORD_END" });
  assert.equal(r.recording, false);
});

// --- Fragment attempts ------------------------------------------------------

test("ATTEMPT_RESULT (fragment passed): feedback phase, fragment marked passed", () => {
  const s = ttsChain(initialPracticeState(3), 2);
  const r = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  assert.equal(r.phase, "feedback");
  assert.equal(r.attemptCount, 1);
  assert.deepEqual(r.passedFragments, [0]);
  assert.equal(r.lastAttempt?.score, 92);
  // Nothing is spoken on pass (feature 110): the flag just marks the feedback
  // phase until CHIME_END ends it.
  assert.equal(r.ttsSpeaking, true);
});

test("feedback CHIME_END (passed): advances to the next fragment", () => {
  let s = ttsChain(initialPracticeState(3), 2);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "CHIME_END" });
  assert.equal(s.phase, "repeatingFragment");
  assert.equal(s.fragmentIndex, 1);
  assert.equal(s.attemptCount, 0);
  assert.equal(s.waitingForUser, true);
});

test("feedback TTS_END (passed): NO-OP — the chime owns the advance (110)", () => {
  let s = ttsChain(initialPracticeState(3), 2);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  const r = reducePractice(s, { type: "TTS_END" });
  assert.equal(r.phase, "feedback"); // unchanged: no double advance
  assert.equal(r.fragmentIndex, 0);
  assert.equal(r.waitingForUser, false);
});

test("feedback CHIME_END (passed, last fragment): moves to fullAnswer", () => {
  let s = ttsChain(initialPracticeState(1), 2);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "CHIME_END" });
  assert.equal(s.phase, "fullAnswer");
  assert.equal(s.waitingForUser, true);
});

test("feedback TTS_END (failed): retries the SAME fragment (CU2 alt flow)", () => {
  let s = ttsChain(initialPracticeState(3), 2);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: failOutcome() });
  s = reducePractice(s, { type: "TTS_END" });
  assert.equal(s.phase, "repeatingFragment");
  assert.equal(s.fragmentIndex, 0); // unchanged
  assert.equal(s.waitingForUser, true);
});

// --- Full answer ------------------------------------------------------------

test("full answer passed → feedback → done", () => {
  let s = ttsChain(initialPracticeState(1), 2);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "CHIME_END" }); // → fullAnswer
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome("full") });
  assert.equal(s.phase, "feedback");
  assert.equal(s.fullAttemptCount, 1);
  assert.equal(s.fullPassed, true);
  assert.equal(reducePractice(s, { type: "TTS_END" }).phase, "feedback"); // pass does not advance on TTS_END
  s = reducePractice(s, { type: "CHIME_END" });
  assert.equal(s.phase, "done");
  assert.equal(s.waitingForUser, false);
});

test("full answer failed → feedback → retries the full answer (not a fragment)", () => {
  let s = ttsChain(initialPracticeState(1), 2);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "CHIME_END" }); // → fullAnswer
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: failOutcome("full") });
  s = reducePractice(s, { type: "TTS_END" });
  assert.equal(s.phase, "fullAnswer");
  assert.equal(s.fullAttemptCount, 1);
  assert.equal(s.fullPassed, false);
  assert.equal(s.waitingForUser, true);
});

// --- Timeout guard ----------------------------------------------------------

test("TIMEOUT while waiting: failed attempt (score 0) + retry", () => {
  const s = ttsChain(initialPracticeState(2), 2);
  const r = reducePractice(s, { type: "TIMEOUT", target: "hello" });
  assert.equal(r.phase, "feedback");
  assert.equal(r.lastAttempt?.score, 0);
  assert.equal(r.lastAttempt?.passed, false);
  assert.equal(r.lastAttempt?.timedOut, true);
  // The attempt result closes the waiting phase → the counter resets.
  assert.equal(r.timeoutCount, 0);
});

test("TIMEOUT while recording: ignored (user is speaking)", () => {
  let s = ttsChain(initialPracticeState(2), 2);
  s = reducePractice(s, { type: "RECORD_START" });
  const r = reducePractice(s, { type: "TIMEOUT", target: "hello" });
  assert.equal(r.recording, true);
  assert.equal(r.lastAttempt, null);
});

test("TIMEOUT outside waiting phases: no-op (guard only fires while waiting)", () => {
  const s = initialPracticeState(2);
  const r = reducePractice(s, { type: "TIMEOUT", target: "hello" });
  assert.equal(r.phase, "question");
  assert.equal(r.timeoutCount, 0);
  assert.equal(r.lastAttempt, null);
});

// --- SKIP / FINISH / EXIT / RETRY -------------------------------------------

test("SKIP: moves to the next fragment (or fullAnswer on the last one)", () => {
  let s = ttsChain(initialPracticeState(3), 2);
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
  let s = ttsChain(initialPracticeState(2), 2);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: failOutcome() });
  const r = reducePractice(s, { type: "RETRY" });
  assert.equal(r.phase, "repeatingFragment");
  assert.equal(r.waitingForUser, true);
  assert.equal(r.timeoutCount, 0);
});

test("ERROR: records the message without breaking the flow", () => {
  const s = reducePractice(initialPracticeState(2), { type: "ERROR", message: "boom" });
  assert.equal(s.error, "boom");
  assert.equal(s.phase, "question");
});

// --- Helpers ----------------------------------------------------------------

test("isOrbEnabled: only true while waiting in repetition phases", () => {
  const s = ttsChain(initialPracticeState(2), 2);
  assert.equal(isOrbEnabled(s), true);
  const recording = reducePractice(s, { type: "RECORD_START" });
  assert.equal(isOrbEnabled(recording), false);
  const start = initialPracticeState(2);
  assert.equal(isOrbEnabled(start), false);
});

test("currentTarget: fragment text in repetition/feedback, answer in fullAnswer", () => {
  const question = {
    fragments: [{ text: "First fragment" }, { text: "Second fragment" }],
    answer: "The whole answer",
  };
  let s = ttsChain(initialPracticeState(2), 2);
  assert.equal(currentTarget(s, question), "First fragment");
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  assert.equal(currentTarget(s, question), "First fragment"); // feedback keeps the target
  s = reducePractice(s, { type: "CHIME_END" });
  assert.equal(currentTarget(s, question), "Second fragment");
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "CHIME_END" }); // → fullAnswer
  assert.equal(currentTarget(s, question), "The whole answer");
});

// --- Spoken lines (feature 115: no opening utterances) ----------------------

test("buildFullLine: kept intact and still spoken before the full answer", () => {
  assert.match(buildFullLine(), /entire answer out loud/);
  // The view speaks it right before the full-answer capture (CU2 step 14)…
  assert.match(viewSrc, /await speak\(fullLine, token\)/);
  // …and the payload still serves it (feature 115: no other opening line).
  assert.equal(buildSessionPayload(payloadSession()).fullLine, buildFullLine());
});

test("zero opening utterances: the opening speech builders no longer exist (115)", () => {
  assert.equal("buildIntroText" in cu2, false);
  assert.equal("buildExplainLine" in cu2, false);
  assert.equal(typeof cu2.buildFullLine, "function");
  // The literal opening texts are gone from the running code (specs/docs and
  // historical comments may still quote them)…
  assert.doesNotMatch(reducerCode, /Welcome to your practice|Now let's practice/);
  assert.doesNotMatch(viewCode, /Welcome to your practice|Now let's practice/);
  // …and the view never reads nor speaks the removed payload fields. Only
  // code-like references are matched (member access, TTS call sites,
  // bindings/assignments, phase literals) on comment-free source, so an
  // innocent prose comment cannot fail the suite.
  const removedViewRefs: RegExp[] = [
    /\.(?:intro|explainLine)\b/, // payload field access (data.intro…)
    /speak(?:WithKaraoke)?\(\s*(?:introText|explainLine)\b/, // TTS call site
    /\b(?:const|let|var)\s+(?:introText|explainLine)\b/, // binding
    /\b(?:introText|explainLine)\s*=[^=]/, // assignment
    /\bphase\s*=\s*"(?:intro|explaining)"/, // view phase literal
  ];
  for (const pattern of removedViewRefs) {
    assert.doesNotMatch(viewCode, pattern, `${pattern} must not appear in practice-view.js`);
  }
});

test("reducer + view: no intro/explaining phases — only the live union (115)", () => {
  const live: PracticePhase[] = ["question", "model", "repeatingFragment", "feedback", "fullAnswer", "done"];
  // The reducer's union is the authoritative list: exact SET of members
  // (order-insensitive), so a harmless reorder of the type cannot fail it.
  const union = /export type PracticePhase =([\s\S]*?);/.exec(reducerCode)?.[1] ?? "";
  assert.deepEqual([...union.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort(), [...live].sort());
  // The view mirrors that union in its own JSDoc type annotation (raw source:
  // the annotation lives in a comment).
  const viewType = /\*\* @type \{("[^}]*")\} \*\//.exec(viewSrc)?.[1] ?? "";
  assert.deepEqual([...viewType.matchAll(/"(\w+)"/g)].map((m) => m[1]).sort(), [...live].sort());
  // The removed phases must not survive as CODE either: only code-like
  // positions are matched (switch cases, phase literals/comparisons, union
  // members) on comment-free source — prose cannot fail this check.
  assert.doesNotMatch(reducerCode, /\bcase\s+"(?:intro|explaining)"/);
  assert.doesNotMatch(reducerCode, /\bphase\s*[:=?]\s*"(?:intro|explaining)"/);
  assert.doesNotMatch(reducerCode, /===?\s*"(?:intro|explaining)"/);
  assert.doesNotMatch(reducerCode, /\|\s*"(?:intro|explaining)"/);
  // And no opening-utterance builder survives in the module's exports.
  assert.deepEqual(Object.keys(cu2).filter((name) => /intro|explain/i.test(name)), []);
});

test("full question walk: question → model → repeatingFragment → … → done, no prelude phase", () => {
  const visited: string[] = [];
  let s = initialPracticeState(1);
  visited.push(s.phase);
  s = reducePractice(s, { type: "TTS_END" }); // question → model
  visited.push(s.phase);
  s = reducePractice(s, { type: "TTS_END" }); // model → first fragment (direct)
  visited.push(s.phase);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  visited.push(s.phase);
  s = reducePractice(s, { type: "CHIME_END" }); // → fullAnswer
  visited.push(s.phase);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome("full") });
  visited.push(s.phase);
  s = reducePractice(s, { type: "CHIME_END" }); // → done
  visited.push(s.phase);
  assert.deepEqual(visited, [
    "question",
    "model",
    "repeatingFragment",
    "feedback",
    "fullAnswer",
    "feedback",
    "done",
  ]);
  assert.equal(visited.includes("intro"), false);
  assert.equal(visited.includes("explaining"), false);
});

// --- Contract of GET /api/session/:id (feature 115) --------------------------

test("GET /api/session/:id payload: exact shape, no intro/explainLine, fullLine present", () => {
  const payload = buildSessionPayload(payloadSession());
  // Exact contract: the route returns exactly this object (it delegates to
  // buildSessionPayload — no second copy of the shape living in the route).
  assert.deepEqual(Object.keys(payload).sort(), [
    "autoAdvance",
    "fullLine",
    "passThreshold",
    "question",
    "session",
  ].sort());
  assert.equal(payload.fullLine, buildFullLine());
  // Threshold / auto-advance come from the session snapshot (features 108/107).
  assert.equal(payload.passThreshold, 80);
  assert.equal(payload.autoAdvance, true);
  // The question served is the LAST one, projected to what the view needs.
  assert.deepEqual(Object.keys(payload.question ?? {}).sort(), ["answer", "fragments", "q"].sort());
  // Feature 115: the opening-speech fields are DELETED, not nulled.
  assert.equal("intro" in payload, false);
  assert.equal("explainLine" in payload, false);
  assert.equal("introText" in payload, false);
  // The route handler is a thin wrapper over the pure helper.
  assert.match(sessionRoutesSrc, /res\.json\(buildSessionPayload\(session\)\)/);
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

test("buildFeedbackText: failed with nothing missing but added words → tells the user to drop them", () => {
  const line = buildFeedbackText({ score: 55, passed: false, missing: [], extra: ["i", "like", "chocolate"], tips: [] });
  assert.match(line, /55 percent/);
  assert.match(line, /Drop the extra words: i, like, chocolate/);
  assert.match(line, /try that again/);
});

test("buildNoSpeechText: plain retry, no score or phantom words", () => {
  const line = buildNoSpeechText();
  assert.match(line, /didn't hear you/);
  assert.doesNotMatch(line, /percent|blank_audio|extra/i);
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
  let s = ttsChain(initialPracticeState(2), 2); // waiting for the user
  s = reducePractice(s, { type: "TTS_START" });
  assert.equal(s.ttsSpeaking, true);
});

// --- Attempt chaining (internal retry) --------------------------------------

test("internal retry that passes: attemptCount chains, same fragment then advances", () => {
  let s = ttsChain(initialPracticeState(2), 2);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: failOutcome() });
  assert.equal(s.attemptCount, 1);
  assert.deepEqual(s.passedFragments, []);

  s = reducePractice(s, { type: "TTS_END" }); // feedback → retry the SAME fragment
  assert.equal(s.phase, "repeatingFragment");
  assert.equal(s.fragmentIndex, 0);

  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  assert.equal(s.attemptCount, 2); // both attempts counted on this fragment
  assert.deepEqual(s.passedFragments, [0]);

  s = reducePractice(s, { type: "CHIME_END" });
  assert.equal(s.fragmentIndex, 1);
  assert.equal(s.attemptCount, 0); // counter resets for the next fragment
});

test("full answer chaining: fail → retry → pass → done (fullAttemptCount 2)", () => {
  let s = ttsChain(initialPracticeState(1), 2);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "CHIME_END" }); // → fullAnswer
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: failOutcome("full") });
  assert.equal(s.fullAttemptCount, 1);
  assert.equal(s.fullPassed, false);
  s = reducePractice(s, { type: "TTS_END" }); // feedback → retry the full answer
  assert.equal(s.phase, "fullAnswer");
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome("full") });
  assert.equal(s.fullAttemptCount, 2);
  assert.equal(s.fullPassed, true);
  s = reducePractice(s, { type: "CHIME_END" });
  assert.equal(s.phase, "done");
});

// --- Timeout guard edges ----------------------------------------------------

test("TIMEOUT in fullAnswer: failed FULL attempt (kind 'full')", () => {
  let s = ttsChain(initialPracticeState(1), 2);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "CHIME_END" }); // → fullAnswer
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
  const start = reducePractice(initialPracticeState(2), { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  assert.equal(start.phase, "question");
  assert.equal(start.attemptCount, 0);
  assert.equal(start.lastAttempt, null);

  let s = ttsChain(initialPracticeState(2), 2);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: failOutcome() }); // → feedback
  const inFeedback = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  assert.equal(inFeedback.phase, "feedback");
  assert.equal(inFeedback.attemptCount, 1); // unchanged
  assert.equal(inFeedback.lastAttempt?.passed, false); // first outcome kept
});

test("RETRY from repeatingFragment: re-arms without changing the fragment", () => {
  const s = ttsChain(initialPracticeState(3), 2);
  const r = reducePractice(s, { type: "RETRY" });
  assert.equal(r.phase, "repeatingFragment");
  assert.equal(r.fragmentIndex, 0);
  assert.equal(r.waitingForUser, true);
  assert.equal(r.timeoutCount, 0);
});

test("RETRY from fullAnswer: re-arms the full answer", () => {
  let s = ttsChain(initialPracticeState(1), 2);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "CHIME_END" }); // → fullAnswer
  const r = reducePractice(s, { type: "RETRY" });
  assert.equal(r.phase, "fullAnswer");
  assert.equal(r.waitingForUser, true);
  assert.equal(r.timeoutCount, 0);
});

test("RETRY outside feedback/repetition phases: no-op", () => {
  const s = reducePractice(initialPracticeState(2), { type: "RETRY" });
  assert.equal(s.phase, "question");
  assert.equal(s.waitingForUser, false);
});

test("SKIP from feedback: advances like from repeatingFragment", () => {
  let s = ttsChain(initialPracticeState(3), 2);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: failOutcome() }); // → feedback
  const next = reducePractice(s, { type: "SKIP" });
  assert.equal(next.phase, "repeatingFragment");
  assert.equal(next.fragmentIndex, 1);
  assert.equal(next.attemptCount, 0);
  assert.equal(next.waitingForUser, true);

  // Last fragment: skip moves straight to the full answer.
  let last = ttsChain(initialPracticeState(1), 2);
  last = reducePractice(last, { type: "ATTEMPT_RESULT", outcome: failOutcome() });
  const full = reducePractice(last, { type: "SKIP" });
  assert.equal(full.phase, "fullAnswer");
  assert.equal(full.waitingForUser, true);
});

test("SKIP outside repetition phases: no-op (question and fullAnswer)", () => {
  const start = reducePractice(initialPracticeState(2), { type: "SKIP" });
  assert.equal(start.phase, "question");

  let full = ttsChain(initialPracticeState(1), 2);
  full = reducePractice(full, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  full = reducePractice(full, { type: "CHIME_END" }); // → fullAnswer
  const r = reducePractice(full, { type: "SKIP" });
  assert.equal(r.phase, "fullAnswer"); // the full answer cannot be skipped
});

// --- EXIT leaves the session open -------------------------------------------

test("EXIT mid-practice: phase stays open (active, resumable)", () => {
  let s = ttsChain(initialPracticeState(3), 2);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() });
  s = reducePractice(s, { type: "CHIME_END" }); // fragment 1 waiting
  const r = reducePractice(s, { type: "EXIT" });
  assert.equal(r.exited, true);
  assert.equal(r.phase, "repeatingFragment"); // NOT done — the session stays open
  assert.equal(r.waitingForUser, false);
  assert.equal(r.recording, false);
  assert.equal(isOrbEnabled(r), false);
});

test("EXIT during feedback (chime in flight): leaves cleanly, nothing stuck", () => {
  let s = ttsChain(initialPracticeState(3), 2);
  s = reducePractice(s, { type: "ATTEMPT_RESULT", outcome: passOutcome() }); // → feedback
  const r = reducePractice(s, { type: "EXIT" });
  assert.equal(r.exited, true);
  assert.equal(r.phase, "feedback");
  assert.equal(r.ttsSpeaking, false); // `cancelFlow()` stopped the audio
  assert.equal(r.waitingForUser, false);
  assert.equal(r.recording, false);
  assert.equal(isOrbEnabled(r), false); // orb rests — no stuck arm
  // The cancelled session is still recoverable (re-entering restarts cleanly).
  const again = reducePractice(r, { type: "ENTER" });
  assert.equal(again.phase, "question");
  assert.equal(again.waitingForUser, false);
});

test("CHIME_END outside feedback: no-op (stray chime events are ignored)", () => {
  const start = reducePractice(initialPracticeState(2), { type: "CHIME_END" });
  assert.equal(start.phase, "question");
  assert.equal(start.fragmentIndex, 0);

  const repeating = reducePractice(ttsChain(initialPracticeState(2), 2), { type: "CHIME_END" });
  assert.equal(repeating.phase, "repeatingFragment");
  assert.equal(repeating.waitingForUser, true);
});

// --- ERROR recovery ---------------------------------------------------------

test("ERROR sticks across TTS_END until ENTER clears it (recovery)", () => {
  let s = reducePractice(initialPracticeState(2), { type: "ERROR", message: "boom" });
  s = reducePractice(s, { type: "TTS_END" });
  assert.equal(s.error, "boom");
  assert.equal(s.phase, "model"); // the flow keeps running
  s = reducePractice(s, { type: "ENTER" });
  assert.equal(s.error, null);
  assert.equal(s.phase, "question");
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
  const otherPhases: PracticePhase[] = ["question", "model", "feedback", "done"];
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
  const armed = ttsChain(initialPracticeState(2), 2);
  const recording = reducePractice(armed, { type: "RECORD_START" });
  assert.equal(isOrbEnabled(recording), false);
});

test('currentTarget: "" outside repetition phases; answer when fragmentIndex is out of range', () => {
  const question = {
    fragments: [{ text: "First fragment" }, { text: "Second fragment" }],
    answer: "The whole answer",
  };
  for (const phase of ["question", "model", "done"] as const) {
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