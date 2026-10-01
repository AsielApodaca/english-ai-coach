import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PushToTalk,
  MIN_PRESS_MS,
  MS_PER_WORD,
  countWords,
  maxCaptureMs,
  wordInteractionAllowed,
} from "../public/speech/ptt.js";

/**
 * Test rig: an injected clock plus spies over the machine's callbacks, so the
 * whole press state machine runs deterministically without real timers.
 */
function rig(opts: { maxCaptureMs?: number; minPressMs?: number; hasAudio?: boolean } = {}) {
  let t = 0;
  let hasAudio = opts.hasAudio ?? false;
  const events: string[] = [];
  const ptt = new PushToTalk({
    maxCaptureMs: opts.maxCaptureMs ?? 60_000,
    minPressMs: opts.minPressMs ?? MIN_PRESS_MS,
    now: () => t,
    hasAudio: () => hasAudio,
    onStart: () => events.push("start"),
    onCut: (reason) => events.push(`cut:${reason}`),
    onDiscard: () => events.push("discard"),
  });
  return {
    ptt,
    events,
    advance: (ms: number) => {
      t += ms;
    },
    setHasAudio: (value: boolean) => {
      hasAudio = value;
    },
  };
}

// --- constants + ceiling ----------------------------------------------------

test("constants: MIN_PRESS_MS is 200 and MS_PER_WORD is 3000", () => {
  assert.equal(MIN_PRESS_MS, 200);
  assert.equal(MS_PER_WORD, 3000);
});

test("countWords: whitespace-insensitive, 0 for blank/non-string", () => {
  assert.equal(countWords("One small step"), 3);
  assert.equal(countWords("  One   small\tstep  "), 3);
  assert.equal(countWords("Hello, world!"), 2);
  assert.equal(countWords(""), 0);
  assert.equal(countWords("   "), 0);
  assert.equal(countWords(null), 0);
  assert.equal(countWords(undefined), 0);
});

test("maxCaptureMs: 3000 ms × word count of the target", () => {
  assert.equal(maxCaptureMs("Repeat after me"), 9000);
  assert.equal(maxCaptureMs("a b c d e f"), 18_000); // 6-word fragment → 18 s
  assert.equal(maxCaptureMs(Array(100).fill("word").join(" ")), 300_000); // full answer
});

test("maxCaptureMs: a blank target keeps one word of budget (no instant cut)", () => {
  assert.equal(maxCaptureMs(""), MS_PER_WORD);
  assert.equal(maxCaptureMs(null), MS_PER_WORD);
});

// --- press state machine ----------------------------------------------------

test("press: idle → recording → release → evaluate", () => {
  const r = rig();
  assert.equal(r.ptt.state, "idle");
  assert.equal(r.ptt.isRecording, false);

  assert.equal(r.ptt.press("pointer"), true);
  assert.equal(r.ptt.state, "recording");
  assert.equal(r.ptt.isRecording, true);
  assert.equal(r.ptt.pressCount, 1);

  r.advance(600);
  assert.equal(r.ptt.release("pointer"), "cut");
  assert.equal(r.ptt.state, "done");
  assert.deepEqual(r.events, ["start", "cut:release"]);
});

test("accidental tap (shorter than MIN_PRESS_MS, no usable audio) does not evaluate", () => {
  const r = rig({ hasAudio: false });
  r.ptt.press("space");
  r.advance(MIN_PRESS_MS - 1);
  assert.equal(r.ptt.release("space"), "discard");
  // The turn keeps waiting: back to idle, no evaluation callback.
  assert.equal(r.ptt.state, "idle");
  assert.deepEqual(r.events, ["start", "discard"]);

  // …and the next press starts a fresh capture with no penalty carried over.
  assert.equal(r.ptt.press("pointer"), true);
  r.advance(MIN_PRESS_MS + 100);
  assert.equal(r.ptt.release("pointer"), "cut");
  assert.deepEqual(r.events, ["start", "discard", "start", "cut:release"]);
});

test("a short press that DID capture usable audio is still evaluated", () => {
  const r = rig({ hasAudio: true });
  r.ptt.press("pointer");
  r.advance(MIN_PRESS_MS - 1);
  assert.equal(r.ptt.release("pointer"), "cut");
  assert.deepEqual(r.events, ["start", "cut:release"]);
});

test("ceiling reached ⇒ auto-release and evaluate (reason 'ceiling')", () => {
  const r = rig({ maxCaptureMs: 3000 });
  r.ptt.press("pointer");

  r.advance(2999);
  assert.equal(r.ptt.tick(), null); // not there yet
  assert.equal(r.ptt.state, "recording");

  r.advance(1);
  assert.equal(r.ptt.tick(), "ceiling");
  assert.equal(r.ptt.state, "done");
  assert.deepEqual(r.events, ["start", "cut:ceiling"]);

  // Neither a later tick nor the user's release can fire a second evaluation.
  assert.equal(r.ptt.tick(), null);
  assert.equal(r.ptt.release("pointer"), null);
  assert.deepEqual(r.events, ["start", "cut:ceiling"]);
});

test("ceiling never fires while the machine is idle", () => {
  const r = rig({ maxCaptureMs: 0 });
  assert.equal(r.ptt.tick(), null);
  assert.deepEqual(r.events, []);
});

test("button + key pressed together → ONE capture, cut when both released", () => {
  const r = rig();
  assert.equal(r.ptt.press("pointer"), true);
  r.advance(50);
  // The second source must not create a second, concurrent capture.
  assert.equal(r.ptt.press("space"), false);
  assert.equal(r.ptt.pressCount, 2);
  assert.equal(r.events.length, 1);

  r.advance(300);
  assert.equal(r.ptt.release("pointer"), null); // the key still holds it
  assert.equal(r.ptt.state, "recording");
  assert.equal(r.ptt.pressCount, 1);

  r.advance(50);
  assert.equal(r.ptt.release("space"), "cut"); // last one out ends the capture
  assert.deepEqual(r.events, ["start", "cut:release"]);
});

test("auto-repeat presses and stray releases never change the state", () => {
  const r = rig();
  r.ptt.press("space");
  // event.repeat → the view filters it; the machine also refuses a re-press.
  assert.equal(r.ptt.press("space"), false);
  assert.equal(r.ptt.pressCount, 1);
  // A release from a source that is not held is ignored.
  assert.equal(r.ptt.release("pointer"), null);
  assert.equal(r.ptt.state, "recording");
  assert.deepEqual(r.events, ["start"]);
});

test("cancel: abandons the turn with no cut and no discard", () => {
  const r = rig();
  r.ptt.press("pointer");
  assert.equal(r.ptt.cancel(), true);
  assert.equal(r.ptt.state, "done");
  assert.equal(r.ptt.pressCount, 0);
  assert.deepEqual(r.events, ["start"]); // audio is dropped by the caller
  // Nothing can revive a cancelled turn.
  assert.equal(r.ptt.press("space"), false);
  assert.equal(r.ptt.cancel(), false);
  assert.equal(r.ptt.tick(), null);
  assert.deepEqual(r.events, ["start"]);
});

// --- karaoke interaction gate (features 112/113) ----------------------------

test("wordInteractionAllowed: only while NOT reading and NOT recording", () => {
  assert.equal(wordInteractionAllowed(), true); // waiting for the turn / review
  assert.equal(wordInteractionAllowed({ recording: true }), false);
  assert.equal(wordInteractionAllowed({ coachSpeaking: true }), false);
  assert.equal(wordInteractionAllowed({ coachSpeaking: true, recording: true }), false);
});

// --- PTT state machine extra coverage ---------------------------------------

test("stray release after done is a no-op", () => {
  const r = rig();
  r.ptt.press("pointer");
  r.advance(MIN_PRESS_MS + 100); // hold long enough to evaluate
  assert.equal(r.ptt.release("pointer"), "cut");
  assert.equal(r.ptt.state, "done");
  // Releasing a source that was already released (machine done) is a no-op.
  const result = r.ptt.release("pointer");
  assert.equal(result, null);
  assert.equal(r.ptt.state, "done");
});

test("press: cannot press after done", () => {
  const r = rig();
  r.ptt.press("pointer");
  r.advance(MIN_PRESS_MS + 100); // hold long enough to evaluate
  assert.equal(r.ptt.release("pointer"), "cut");
  assert.equal(r.ptt.state, "done");
  // Press after capture is done is ignored.
  assert.equal(r.ptt.press("pointer"), false);
  assert.equal(r.ptt.state, "done");
});

test("countWords: single word returns 1", () => {
  assert.equal(countWords("Hello"), 1);
  assert.equal(countWords("a"), 1);
});

test("countWords: multiple spaces between words", () => {
  assert.equal(countWords("Hello   world"), 2);
  assert.equal(countWords("  Hello\t\tworld  "), 2);
});
