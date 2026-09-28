import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MIN_VOLUME_PCT,
  MAX_VOLUME_PCT,
  clampVolumePct,
  volumeFactor,
} from "../public/ui/settings/volume.js";

// ---------------------------------------------------------------------------
// clampVolumePct
// ---------------------------------------------------------------------------

test("volume: the usable range is 10–100%", () => {
  assert.equal(MIN_VOLUME_PCT, 10);
  assert.equal(MAX_VOLUME_PCT, 100);
});

test("volume: clampVolumePct keeps values inside the range", () => {
  assert.equal(clampVolumePct(20), 20);
  assert.equal(clampVolumePct(10), 10);
  assert.equal(clampVolumePct(100), 100);
  assert.equal(clampVolumePct("55"), 55, "numeric strings are accepted");
});

test("volume: values below the floor are raised to 10%", () => {
  assert.equal(clampVolumePct(0), MIN_VOLUME_PCT, "legacy stored 0 is not silent");
  assert.equal(clampVolumePct(-5), MIN_VOLUME_PCT);
  assert.equal(clampVolumePct(9.9), MIN_VOLUME_PCT);
});

test("volume: values above 100 are clamped down", () => {
  assert.equal(clampVolumePct(150), MAX_VOLUME_PCT);
});

test("volume: missing or unparseable values fall back to 100%", () => {
  assert.equal(clampVolumePct(undefined), 100);
  assert.equal(clampVolumePct(null), 100);
  assert.equal(clampVolumePct(""), 100);
  assert.equal(clampVolumePct("loud"), 100);
  assert.equal(clampVolumePct(Number.NaN), 100);
  assert.equal(clampVolumePct(undefined, 40), 40, "custom fallback");
});

// ---------------------------------------------------------------------------
// volumeFactor
// ---------------------------------------------------------------------------

test("volume: volumeFactor converts the percentage to a 0.1–1 factor", () => {
  assert.equal(volumeFactor(100), 1);
  assert.equal(volumeFactor(20), 0.2);
  assert.equal(volumeFactor(0), 0.1, "0% reads as the floor, not as silence");
  assert.equal(volumeFactor("50"), 0.5);
});
