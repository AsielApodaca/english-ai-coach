import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEdgeTts, synthesizeEdge, edgeRateArg, DEFAULT_EDGE_VOICE } from "../src/lib/edge-tts.ts";

// If edge-tts is actually installed on this machine, the "unavailable" paths
// below are not applicable and are skipped instead of failing.
const edgeInstalled = checkEdgeTts().available;

test("checkEdgeTts: reports unavailable when edge-tts is not installed", { skip: edgeInstalled && "edge-tts is installed; unavailable path not applicable" }, () => {
  const handle = checkEdgeTts();
  assert.equal(handle.available, false);
  assert.equal(handle.binary, null);
  assert.equal(handle.voiceName, DEFAULT_EDGE_VOICE);
  assert.match(handle.hint, /pip install edge-tts/);
});

test("synthesizeEdge: throws edge-tts-unavailable without the CLI", { skip: edgeInstalled && "edge-tts is installed; unavailable path not applicable" }, async () => {
  await assert.rejects(() => synthesizeEdge("hello", process.cwd()), /edge-tts-unavailable/);
});

test("edgeRateArg: maps a speed factor to the edge-tts --rate suffix", () => {
  assert.equal(edgeRateArg(1), "0%");
  assert.equal(edgeRateArg(1.1), "+10%");
  assert.equal(edgeRateArg(0.95), "-5%");
  assert.equal(edgeRateArg(2), "+100%");
  assert.equal(edgeRateArg(0.5), "-50%");
});