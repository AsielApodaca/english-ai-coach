import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { BrowserSTT } from "../public/speech/browser-stt.js";

// ---------------------------------------------------------------------------
// Browser globals (BrowserSTT talks to `window.SpeechRecognition`; Node has
// none of them, so the suite installs a fake recognition whose native events
// can be fired manually — that is the whole point: `abort()` settles the turn
// synchronously, but the native `end` of the aborted session lands LATER and
// must be ignored (feature 111: accidental tap keeps the turn waiting).
// ---------------------------------------------------------------------------

/** Stand-in for `webkitSpeechRecognition` with manually fired native events. */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  onstart: (() => void) | null = null;
  onresult: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  startCalls = 0;
  stopCalls = 0;
  abortCalls = 0;

  constructor() {
    FakeRecognition.instances.push(this);
  }

  start() {
    this.startCalls++;
    this.onstart?.();
  }

  stop() {
    this.stopCalls++;
  }

  abort() {
    this.abortCalls++;
  }

  /** Fire the native `end` the browser dispatches after stop()/abort(). */
  fireEnd() {
    this.onend?.();
  }

  /** Fire the native `error` event (e.g. microphone permission denied). */
  fireError(error: string) {
    this.onerror?.({ error });
  }
}

const originalWindow = globalThis.window;
Object.assign(globalThis, { window: { SpeechRecognition: FakeRecognition } });

after(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    Object.assign(globalThis, { window: originalWindow });
  }
});

/** Fresh recognizer for every test, so instances never leak across them. */
beforeEach(() => {
  FakeRecognition.instances.length = 0;
});

// --- stale end after abort (feature 111 accidental tap) ---------------------

test("BrowserSTT: native end of an aborted session is ignored", () => {
  const ends: number[] = [];
  const stt = new BrowserSTT({ onFinal: () => {}, onEnd: () => ends.push(1) });
  assert.equal(stt.start(), true);
  const rec = FakeRecognition.instances[0];

  stt.abort(); // accidental tap: settles synchronously, session is gone
  assert.equal(ends.length, 1);
  assert.equal(rec.abortCalls, 1);

  rec.fireEnd(); // the browser still dispatches the native end — late
  assert.equal(ends.length, 1, "the late native end must not settle again");
});

test("BrowserSTT: end of a replaced session never settles the new one", () => {
  const ends: number[] = [];
  const stt = new BrowserSTT({ onFinal: () => {}, onEnd: () => ends.push(1) });
  stt.start();
  const first = FakeRecognition.instances[0];
  stt.abort();
  assert.equal(ends.length, 1);

  stt.start(); // next press: a brand-new recognition session
  const second = FakeRecognition.instances[1];
  assert.notEqual(first, second);

  first.fireEnd(); // late event from the OLD session
  assert.equal(ends.length, 1, "the replaced session's end is stale");

  second.fireEnd(); // the CURRENT session ends normally
  assert.equal(ends.length, 2);
});

// --- normal paths keep working ----------------------------------------------

test("BrowserSTT: stop() + native end settles exactly once with the result", () => {
  let text: string | null = null;
  const stt = new BrowserSTT({
    onFinal: () => {},
    onEnd: () => {
      text = stt.result();
    },
  });
  stt.start();
  const rec = FakeRecognition.instances[0];
  rec.onresult?.({
    resultIndex: 0,
    results: [{ isFinal: true, 0: { transcript: "hello world" } }],
  });

  stt.stop();
  assert.equal(rec.stopCalls, 1);
  assert.equal(text, null, "stop() alone must not settle; the native end does");

  rec.fireEnd();
  assert.equal(text, "hello world");
  assert.equal(stt.result(), "hello world");
});

test("BrowserSTT: permission error still settles the turn (guard not overzealous)", () => {
  let errors = 0;
  let ends = 0;
  const stt = new BrowserSTT({
    onFinal: () => {},
    onEnd: () => ends++,
    onError: () => errors++,
  });
  stt.start();
  const rec = FakeRecognition.instances[0];

  rec.fireError("not-allowed");
  assert.equal(errors, 1);
  assert.equal(ends, 1, "not-allowed must end the turn so it cannot hang");
});

test("BrowserSTT: start() is a no-op while a session is live", () => {
  const stt = new BrowserSTT({ onFinal: () => {}, onEnd: () => {}, onError: () => {} });
  assert.equal(stt.start(), true);
  assert.equal(stt.start(), true);
  assert.equal(FakeRecognition.instances.length, 1, "no second recognition");
});
