import { test } from "node:test";
import assert from "node:assert/strict";

import { VadTracker } from "../public/speech/vad.js";

test("VadTracker: silence before speech yields nothing", () => {
  let t = 0;
  const vad = new VadTracker({ now: () => t, silenceMs: 120 });
  assert.equal(vad.feed(-70), null);
  assert.equal(vad.feed(-Infinity), null);
  assert.equal(vad.speechSeen, false);
});

test("VadTracker: first loud frame reports start", () => {
  let t = 0;
  const vad = new VadTracker({ now: () => t, silenceMs: 120 });
  assert.equal(vad.feed(-80), null);
  assert.equal(vad.feed(-40), "start");
  assert.equal(vad.speechSeen, true);
  // Already-seen speech: loud frames keep feeding silently.
  assert.equal(vad.feed(-30), null);
});

test("VadTracker: sustained silence after speech reports end", () => {
  let t = 0;
  const vad = new VadTracker({ now: () => t, silenceMs: 120 });
  vad.feed(-40); // "start" — speech begins
  assert.equal(vad.feed(-30), null); // still talking
  assert.equal(vad.feed(-70), null); // silence streak begins (arms the sniper)
  t += 100;
  assert.equal(vad.feed(-70), null); // not long enough yet
  t += 30;
  assert.equal(vad.feed(-80), "silence"); // 130ms >= 120ms elapsed
});

test("VadTracker: continued speech never arms the silence sniper", () => {
  let t = 0;
  const vad = new VadTracker({ now: () => t, silenceMs: 120 });
  vad.feed(-40); // speech
  vad.feed(-70); // brief silence arms the sniper
  t += 100;
  vad.feed(-25); // speaks again — disarms the sniper
  t += 500; // long gap, but it never spent 120ms consecutive silent
  assert.equal(vad.feed(-70), null);
  assert.equal(vad.feed(-35), null);
});

test("VadTracker: loud frames above the threshold count as speech", () => {
  let t = 0;
  const vad = new VadTracker({ now: () => t, speechDb: -55, silenceMs: 100 });
  assert.equal(vad.feed(-54), "start");
});

test("VadTracker: re-arms after firing so a second utterance can fire again", () => {
  let t = 0;
  const vad = new VadTracker({ now: () => t, silenceMs: 120 });
  vad.feed(-40); // start speaking (t=0)
  t += 100;
  assert.equal(vad.feed(-70), null); // silence streak begins → arms (t=100)
  t += 130;
  assert.equal(vad.feed(-70), "silence"); // 130ms >= 120ms → first fire
  t += 100;
  assert.equal(vad.feed(-70), null); // sniper re-armed, streak restarted (t=330)
  t += 130;
  assert.equal(vad.feed(-80), "silence"); // can fire again
});