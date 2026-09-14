import { test } from "node:test";
import assert from "node:assert/strict";
import { pickStt } from "../public/speech/stt-pick.js";

const ready = { whisper: { available: true, modelReady: true } };
const installedNoModel = { whisper: { available: true, modelReady: false } };
const notInstalled = { whisper: { available: false, modelReady: false } };
const noWhisper = {};

test("pickStt: whisper ready + no user choice → whisper", () => {
  assert.equal(pickStt(ready, null), "whisper");
});

test("pickStt: whisper ready + user chose browser → browser", () => {
  assert.equal(pickStt(ready, "browser"), "browser");
});

test("pickStt: whisper ready + user chose whisper → whisper", () => {
  assert.equal(pickStt(ready, "whisper"), "whisper");
});

test("pickStt: whisper not ready + no user choice → browser", () => {
  assert.equal(pickStt(installedNoModel, null), "browser");
  assert.equal(pickStt(notInstalled, null), "browser");
  assert.equal(pickStt(noWhisper, null), "browser");
});

test("pickStt: explicit whisper choice respected even when not ready", () => {
  assert.equal(pickStt(notInstalled, "whisper"), "whisper");
});

test("pickStt: invalid stored value treated as no choice", () => {
  assert.equal(pickStt(ready, "garbage"), "whisper");
  assert.equal(pickStt(notInstalled, "garbage"), "browser");
});

test("pickStt: undefined/null health treated as not ready", () => {
  assert.equal(pickStt(undefined, null), "browser");
  assert.equal(pickStt(null, null), "browser");
});

test("pickStt: undefined userChoice treated as no choice", () => {
  assert.equal(pickStt(ready, undefined), "whisper");
  assert.equal(pickStt(notInstalled, undefined), "browser");
});