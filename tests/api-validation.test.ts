import { test } from "node:test";
import assert from "node:assert/strict";

import { isAttemptWords, isSessionEval, isValidSessionId } from "../src/lib/session/storage.ts";
import { isProviderId, PROVIDER_IDS, type ProviderId } from "../src/lib/providers/types.ts";
import { isWavBuffer } from "../src/lib/audio/wav.ts";

// ---------------------------------------------------------------------------
// Feature 117 — input-validation guards. These are the executable spec of the
// 400-side of /api/session/checkpoint, /api/evaluate, /api/attempt,
// /api/session/save and /api/chat: every guard below must reject a payload
// the old code would have persisted (or blindly cast) as-is.
// ---------------------------------------------------------------------------

// --- isValidSessionId (same criterion storage.sessionFile() enforces) -------

test("isValidSessionId: generated UUIDs and simple ids pass", () => {
  assert.equal(isValidSessionId("0f1c9e2a-1d3b-4c5e-8f7a-9b0c1d2e3f40"), true);
  assert.equal(isValidSessionId("session-1"), true);
  assert.equal(isValidSessionId("ABC123"), true);
});

test("isValidSessionId: path escapes, separators and empties fail", () => {
  assert.equal(isValidSessionId("../evil"), false);
  assert.equal(isValidSessionId("a/b"), false);
  assert.equal(isValidSessionId("id with spaces"), false);
  assert.equal(isValidSessionId(""), false);
  assert.equal(isValidSessionId("id.json"), false); // dot is not in the charset
});

// --- isSessionEval ----------------------------------------------------------

const validEval = {
  score: 82,
  verdict: "great",
  matched: ["I", "handled"],
  missing: ["it"],
  extra: [],
  issues: [{ category: "grammar", message: "Use past tense.", fix: "handled" }],
  tips: ["Keep sentences short."],
  next: true,
};

test("isSessionEval: the full SessionEval contract passes", () => {
  assert.equal(isSessionEval(validEval), true);
  // optional `fix` omitted is fine too
  assert.equal(
    isSessionEval({ ...validEval, issues: [{ category: "other", message: "m" }] }),
    true,
  );
});

test("isSessionEval: partial or mistyped objects fail (never persisted)", () => {
  assert.equal(isSessionEval(null), false);
  assert.equal(isSessionEval("great"), false);
  assert.equal(isSessionEval([validEval]), false);
  assert.equal(isSessionEval({ ...validEval, verdict: "awesome" }), false);
  assert.equal(isSessionEval({ ...validEval, score: "82" }), false);
  assert.equal(isSessionEval({ ...validEval, next: "yes" }), false);
  assert.equal(isSessionEval({ ...validEval, matched: [42] }), false);
  assert.equal(isSessionEval({ ...validEval, issues: [{ category: "vibes", message: "m" }] }), false);
  // the old `as SessionEval` cast accepted this one — now it is rejected
  assert.equal(isSessionEval({ score: 10 }), false);
});

// --- isAttemptWords ---------------------------------------------------------

const validWords = [
  { word: "I", status: "green", startMs: 0, endMs: 120 },
  { word: "handled", status: "amber" },
  { word: "it", status: "red", startMs: 300, endMs: 360 },
];

test("isAttemptWords: AttemptWord entries pass (timestamps optional)", () => {
  assert.equal(isAttemptWords(validWords), true);
  assert.equal(isAttemptWords([]), true);
});

test("isAttemptWords: wrong shapes fail", () => {
  assert.equal(isAttemptWords("green"), false);
  assert.equal(isAttemptWords(null), false);
  assert.equal(isAttemptWords([null]), false);
  assert.equal(isAttemptWords([{ word: "I", status: "blue" }]), false);
  assert.equal(isAttemptWords([{ word: "I" }]), false); // status required
  // WhisperWord-ish entries ({ text, startMs, endMs }) without status → rejected
  assert.equal(isAttemptWords([{ text: "I", startMs: 0, endMs: 120 }]), false);
  assert.equal(isAttemptWords([{ word: "I", status: "green", startMs: "soon" }]), false);
});

// --- isProviderId -----------------------------------------------------------

test("isProviderId: every configured provider id is accepted", () => {
  for (const id of PROVIDER_IDS) {
    assert.equal(isProviderId(id), true, `expected ${id} to be a provider id`);
  }
  // The list stays a ProviderId list at compile time (typed as readonly ProviderId[]).
  const typed: readonly ProviderId[] = PROVIDER_IDS;
  assert.equal(typed.length, PROVIDER_IDS.length);
});

test("isProviderId: unknown ids, non-strings and nullish fail", () => {
  assert.equal(isProviderId("gpt-9000"), false);
  assert.equal(isProviderId(""), false);
  assert.equal(isProviderId("MOCK"), false); // ids are case-sensitive
  assert.equal(isProviderId(42), false);
  assert.equal(isProviderId(null), false);
  assert.equal(isProviderId(undefined), false);
  assert.equal(isProviderId({ id: "mock" }), false);
});

// --- isWavBuffer ------------------------------------------------------------

function bytesOf(...chunks: Array<[offset: number, text: string]>): Uint8Array {
  const buf = new Uint8Array(44);
  for (const [offset, text] of chunks) {
    for (let i = 0; i < text.length; i++) buf[offset + i] = text.charCodeAt(i);
  }
  return buf;
}

test("isWavBuffer: a canonical RIFF/WAVE header passes", () => {
  const header = bytesOf([0, "RIFF"], [8, "WAVE"]);
  assert.equal(isWavBuffer(header), true);
});

test("isWavBuffer: non-WAV payloads and truncated bodies fail", () => {
  assert.equal(isWavBuffer(new TextEncoder().encode('{"message":"hello"}')), false);
  assert.equal(isWavBuffer(new TextEncoder().encode("<html>not audio</html>")), false);
  assert.equal(isWavBuffer(bytesOf([0, "RIFF"], [8, "AVI "])), false); // RIFF but not WAVE
  assert.equal(isWavBuffer(new TextEncoder().encode("RIFF")), false); // truncated
  assert.equal(isWavBuffer(new Uint8Array(0)), false);
});
