import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chimePlan } from "../public/speech/chime.js";

// Feature 110: only the PURE core is tested here — Node has no AudioContext,
// which is exactly why the plan/envelope lives in `chimePlan()`.

// --- Duration budget ---------------------------------------------------------

test("chimePlan: duration is positive and within the 300 ms budget", () => {
  for (const kind of ["pass", "fail"] as const) {
    const plan = chimePlan({ kind });
    assert.ok(plan.durationMs > 0, `${kind} chime must last more than 0 ms`);
    assert.ok(plan.durationMs <= 300, `${kind} chime must fit in 300 ms`);
  }
});

// --- Envelope ----------------------------------------------------------------

test("chimePlan: short attack ramp, longer fade-out decay, both in range", () => {
  const { attack, decay, durationMs } = chimePlan();
  assert.equal(attack.start, 0);
  assert.ok(attack.end > attack.start, "the attack must ramp up from silence");
  assert.equal(decay.start, attack.end, "the decay starts where the attack ends");
  assert.ok(decay.end > decay.start, "the decay must fade out");
  assert.ok(decay.end <= durationMs, "the envelope cannot outlive the chime");

  const attackLength = attack.end - attack.start;
  const decayLength = decay.end - decay.start;
  assert.ok(attackLength < decayLength, "attack must be shorter than the decay");
});

// --- Tones -------------------------------------------------------------------

test("chimePlan: pass tones sit in the gentle musical range (600–2500 Hz)", () => {
  const { frequencies } = chimePlan({ kind: "pass" });
  assert.ok(frequencies.length >= 1);
  for (const frequency of frequencies) {
    assert.ok(frequency >= 600 && frequency <= 2500, `${frequency} Hz outside 600–2500 Hz`);
  }
});

test("chimePlan: tones stay below the Nyquist limit of the sample rate", () => {
  const { frequencies } = chimePlan({ sampleRate: 1600 });
  for (const frequency of frequencies) {
    assert.ok(frequency < 800, `${frequency} Hz must be clamped below 800 Hz`);
  }
});

// --- Gain clamp (same floor as volumeSetting()) ------------------------------

test("chimePlan: gain is monotonically clamped by the coach volume", () => {
  const gainAt = (volume: number) => chimePlan({ volume }).gain;

  // Same 10% floor as `volumeSetting()`/`volumeFactor`: 0 and negative never
  // mute the chime — both land exactly on the floor.
  assert.ok(gainAt(0) > 0, "the floor keeps a faint chime at volume 0");
  assert.equal(gainAt(0), gainAt(-2));

  // Clamped at the top: above 1 cannot get louder than at 1, and never > 1.
  assert.ok(gainAt(1) <= 1);
  assert.equal(gainAt(1), gainAt(1.5));

  // Monotone non-decreasing across the whole input range.
  const samples = [-2, 0, 0.25, 0.5, 0.75, 1, 1.5];
  for (let i = 1; i < samples.length; i++) {
    assert.ok(
      gainAt(samples[i - 1]) <= gainAt(samples[i]),
      `gain must not drop from ${samples[i - 1]} to ${samples[i]}`,
    );
  }
});

// --- Kinds -------------------------------------------------------------------

test("chimePlan: kind fail is a descending sequence, as loud as kind pass", () => {
  const pass = chimePlan({ kind: "pass" });
  const fail = chimePlan({ kind: "fail" });
  // The fail cue plays right after the user's own replay: it must cut through,
  // so it is never quieter than the "correcto" cue.
  assert.ok(fail.gain >= pass.gain, "the fail chime must be at least as loud");
  assert.ok(
    Math.max(...fail.frequencies) < Math.max(...pass.frequencies),
    "the fail chime must sit lower",
  );
  // Two notes played one AFTER the other (pass is a simultaneous chord)…
  assert.equal(fail.notes.length, 2);
  assert.equal(pass.notes.every((note) => note.startMs === 0), true);
  // …and the second one is lower: that is what reads as "incorrecto".
  assert.ok(fail.notes[1].frequency < fail.notes[0].frequency, "the tone must go DOWN");
  assert.ok(fail.notes[1].startMs >= fail.decay.end, "the notes must not overlap");
  assert.equal(fail.durationMs, fail.notes[1].startMs + fail.decay.end);
});

test("chimePlan: kind pass keeps its original 250 ms chord", () => {
  const pass = chimePlan({ kind: "pass" });
  assert.equal(pass.durationMs, 250);
  assert.deepEqual(pass.notes.map((note) => note.startMs), [0, 0]);
});

test("chimePlan: defaults to the pass kind", () => {
  assert.deepEqual(chimePlan(), chimePlan({ kind: "pass" }));
});

// --- Wiring in the view ------------------------------------------------------

const viewSrc = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "public", "ui", "practice-view.js"),
  "utf8",
);

test("view: one chime per outcome, pass and fail, in both attempt loops", () => {
  // Fragment loop + full-answer loop → two call sites per outcome.
  assert.equal(viewSrc.match(/playAttemptChime\("pass"\)/g)?.length, 2);
  assert.equal(viewSrc.match(/playAttemptChime\("fail"\)/g)?.length, 2);
});

test("view: the fail chime plays before the focus hint is spoken", () => {
  const tails = viewSrc.split('await playAttemptChime("fail");').slice(1);
  assert.equal(tails.length, 2, "both fail paths must play the chime");
  for (const tail of tails) {
    const speakAt = tail.indexOf("if (refinedLine) await speak(refinedLine, token);");
    assert.ok(speakAt > -1, "the guarded focus line must follow the fail chime");
    // Nothing spoken between the chime and the hint (chimes never overlap TTS).
    assert.ok(!tail.slice(0, speakAt).includes("await speak("));
  }
  // The spoken opener is gone from the view: the chime replaced it.
  assert.doesNotMatch(viewSrc, /Almost there\. That was/);
});
