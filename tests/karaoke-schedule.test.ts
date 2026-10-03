import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildWordStarts } from "../public/ui/karaoke-schedule.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Pure schedule math (feature 114 pause-aware karaoke, review major #1)
// ---------------------------------------------------------------------------

test("buildWordStarts: with all-zero pauses the schedule IS the linear spread", () => {
  const durationMs = 3000;
  const segments = ["one two", "three four five"];
  const starts = buildWordStarts(durationMs, segments, [0, 0], 5);
  assert.ok(starts, "a zero-pause schedule is still computable");
  assert.equal(starts.length, 5);
  starts.forEach((s, i) => {
    const linear = (i * durationMs) / 5;
    assert.ok(Math.abs(s - linear) < 1e-9, `word ${i}: ${s} ≠ linear ${linear}`);
  });
});

test("buildWordStarts: real pauses widen the gap across the clause boundary", () => {
  const durationMs = 4000; // 2850 ms of speech + 1000/650 ms silences
  const segments = ["one two", "three four"];
  const pausesMs = [1000, 650];
  const starts = buildWordStarts(durationMs, segments, pausesMs, 4);
  assert.ok(starts, "schedule computed for real pauses");

  // The gap around the pause must exceed a plain linear step (linear = 1000 ms):
  // the highlight waits out the silence instead of racing ahead of the coach.
  const linearStep = durationMs / 4;
  const boundaryGap = starts[2] - starts[1];
  assert.ok(boundaryGap > linearStep, `boundary gap ${boundaryGap} ≤ linear ${linearStep}`);

  // Monotonic and inside the audio.
  for (let i = 1; i < starts.length; i++) {
    assert.ok(starts[i] >= starts[i - 1], `onset ${i} went backwards`);
  }
  assert.ok(starts[starts.length - 1] < durationMs, "last word lights before the audio ends");
});

test("buildWordStarts: impossible inputs fall back to null (linear is the safety net)", () => {
  const segments = ["one two", "three four"];
  const pausesMs = [220, 650];
  assert.equal(buildWordStarts(0, segments, pausesMs, 4), null, "no duration");
  assert.equal(buildWordStarts(-1, segments, pausesMs, 4), null, "negative duration");
  assert.equal(buildWordStarts(4000, [], [], 4), null, "no segments");
  assert.equal(buildWordStarts(4000, segments, [220], 4), null, "pause count mismatch");
  assert.equal(buildWordStarts(4000, segments, pausesMs, 5), null, "span count mismatch");
  assert.equal(buildWordStarts(4000, segments, [0, 0], 0), null, "zero spans");
  assert.equal(buildWordStarts(1000, segments, [800, 800], 4), null, "pauses exceed duration");
});

// ---------------------------------------------------------------------------
// Integration pin: the practice view only applies the schedule when the
// response actually carries the silences (no DOM harness → source pattern)
// ---------------------------------------------------------------------------

test("practice-view: pause-aware schedule gated on the response's X-TTS-Pauses header", () => {
  const viewSrc = readFileSync(join(repoRoot, "public", "ui", "practice-view.js"), "utf8");
  assert.match(
    viewSrc,
    /headers\.get\("X-TTS-Pauses"\)\s*===\s*"measured"/,
    "speakWithKaraoke must read X-TTS-Pauses off the response",
  );
  assert.match(
    viewSrc,
    /pausesMeasured\s*\?\s*buildWordStarts\(/,
    "buildWordStarts must only run for a measured-pauses response (edge → linear)",
  );
});
