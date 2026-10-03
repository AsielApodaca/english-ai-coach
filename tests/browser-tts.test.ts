import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";

import { BrowserTTS, chunkTokens, MAX_TOKEN_SEGMENTS } from "../public/speech/browser-tts.js";

// ---------------------------------------------------------------------------
// Browser globals (BrowserTTS talks to `window`, `fetch`, `Audio` and
// `speechSynthesis`; Node has none of them, so the suite installs fakes).
// ---------------------------------------------------------------------------

/** Every `<audio>` element the engine created, in creation order. */
class FakeAudio {
  static instances: FakeAudio[] = [];
  src: string;
  paused = true;
  volume = 1;
  playbackRate = 1;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(url: string) {
    this.src = url;
    FakeAudio.instances.push(this);
  }

  play() {
    this.paused = false;
    return Promise.resolve();
  }

  pause() {
    this.paused = true;
  }
}

/** Stand-in for SpeechSynthesisUtterance. */
class FakeUtterance {
  text: string;
  rate = 1;
  pitch = 1;
  volume = 1;
  lang = "";
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(text: string) {
    this.text = text;
  }
}

/**
 * Fake Web Speech queue. Like the real API, `cancel()` makes the utterance
 * being spoken fail (`onerror`) and never reach `onend`.
 */
const synthesis = {
  spoken: [] as FakeUtterance[],
  cancelled: 0,
  current: null as FakeUtterance | null,
  getVoices: () => [],
  speak(utt: FakeUtterance) {
    synthesis.spoken.push(utt);
    synthesis.current = utt;
    setTimeout(() => {
      if (synthesis.current === utt) {
        synthesis.current = null;
        utt.onend?.();
      }
    }, 0);
  },
  cancel() {
    synthesis.cancelled++;
    const utt = synthesis.current;
    synthesis.current = null;
    if (utt) setTimeout(() => utt.onerror?.(), 0);
  },
};

/** Minimal Response stand-in for the `/api/tts` stubs. */
function audioResponse(): Response {
  return { ok: true, blob: async () => new Blob(["RIFF"]) } as unknown as Response;
}

/** Stub `globalThis.fetch`; `n` deferred responses are released by the test. */
function deferredFetch(): { respond(index: number): void; count(): number } {
  const resolvers: ((r: Response) => void)[] = [];
  const stub = () =>
    new Promise<Response>((resolve) => {
      resolvers.push(resolve);
    });
  (globalThis as { fetch: unknown }).fetch = stub;
  return {
    respond: (index: number) => resolvers[index](audioResponse()),
    count: () => resolvers.length,
  };
}

const originalFetch = globalThis.fetch;

Object.assign(globalThis, {
  window: { speechSynthesis: synthesis },
  speechSynthesis: synthesis,
  SpeechSynthesisUtterance: FakeUtterance,
  Audio: FakeAudio,
});

after(() => {
  globalThis.fetch = originalFetch;
});

beforeEach(() => {
  FakeAudio.instances.length = 0;
  synthesis.spoken.length = 0;
  synthesis.cancelled = 0;
  synthesis.current = null;
});

/** Yield the microtask/macrotask queue `times` times. */
async function tick(times = 4) {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

/** A TTS instance with the server layer enabled (Piper). */
function serverTts() {
  const tts = new BrowserTTS();
  tts.setHealth({ tts: { engine: "piper" } });
  return tts;
}

/** Server answers right away: `ok` toggles audio vs "no engine". */
function immediateFetch(ok: boolean) {
  (globalThis as { fetch: unknown }).fetch = async () =>
    (ok ? audioResponse() : ({ ok: false } as unknown as Response));
}

// ---------------------------------------------------------------------------
// Regression: audio kept playing after leaving the practice session
// ---------------------------------------------------------------------------

test("stop() during server playback resolves false and never falls back to speechSynthesis", async () => {
  immediateFetch(true);
  const tts = serverTts();

  const pending = tts.speak("hello coach");
  await tick();
  assert.equal(FakeAudio.instances.length, 1, "server audio was created");
  assert.equal(FakeAudio.instances[0].paused, false, "server audio is playing");

  tts.stop(); // ← user clicks "New Session" mid-line
  const ok = await pending;

  assert.equal(ok, false);
  assert.equal(FakeAudio.instances[0].paused, true, "server audio was paused");
  assert.equal(synthesis.spoken.length, 0, "no browser utterance was queued");
});

test("stop() while the TTS audio is still fetching plays nothing at all", async () => {
  const fetchCtl = deferredFetch();
  const tts = serverTts();

  const pending = tts.speak("hello coach");
  assert.equal(fetchCtl.count(), 1);
  tts.stop(); // ← leaves the session before /api/tts answers
  fetchCtl.respond(0);
  await tick();

  assert.equal(FakeAudio.instances.length, 0, "no audio element was created");
  assert.equal(synthesis.spoken.length, 0, "no browser utterance was queued");
  tts.stop(); // settle the read if it somehow survived
  assert.equal(await pending, false);
});

test("stop() cancels an in-flight browser read (speechSynthesis layer)", async () => {
  const tts = new BrowserTTS(); // no server engine → straight to layer 2

  const pending = tts.speak("hello coach");
  tts.stop();

  assert.equal(await pending, false);
  assert.equal(synthesis.cancelled > 0, true, "speechSynthesis.cancel() ran");
  assert.equal(synthesis.current, null, "no utterance is left speaking");
});

// ---------------------------------------------------------------------------
// The fallback itself must keep working (stop() must not disable the engine)
// ---------------------------------------------------------------------------

test("a genuine server failure still falls back to speechSynthesis", async () => {
  immediateFetch(false);
  const tts = serverTts();

  const ok = await tts.speak("fallback line");

  assert.equal(ok, true);
  assert.equal(synthesis.spoken.length, 1);
  assert.equal(synthesis.spoken[0].text, "fallback line");
});

test("a fresh read plays normally after a previous stop()", async () => {
  immediateFetch(false);
  const tts = serverTts();

  tts.stop();
  const ok = await tts.speak("again");

  assert.equal(ok, true);
  assert.equal(synthesis.spoken.length, 1);
});

test("a newer speak() supersedes the previous one instead of playing over it", async () => {
  const fetchCtl = deferredFetch();
  const tts = serverTts();

  const first = tts.speak("first line");
  fetchCtl.respond(0);
  await tick();
  assert.equal(FakeAudio.instances.length, 1);
  assert.equal(FakeAudio.instances[0].paused, false);

  const second = tts.speak("second line");
  fetchCtl.respond(1);
  await tick();

  assert.equal(await first, false, "the superseded read resolves false");
  assert.equal(FakeAudio.instances[0].paused, true, "the superseded audio was paused");
  assert.equal(FakeAudio.instances.length, 2, "the new read owns its own audio");
  assert.equal(synthesis.spoken.length, 0, "neither read leaked into speechSynthesis");

  FakeAudio.instances[1].onended?.();
  assert.equal(await second, true, "the newest read still finishes normally");
});

// ---------------------------------------------------------------------------
// Volume: the setting must apply on start and while the coach is speaking
// ---------------------------------------------------------------------------

test("a read honours the configured volume instead of defaulting to 100%", async () => {
  immediateFetch(true);
  const tts = serverTts();

  const pending = tts.speak("quiet line", { volume: 0.2 });
  await tick();

  assert.equal(FakeAudio.instances[0].volume, 0.2, "server audio starts at 20%");

  FakeAudio.instances[0].onended?.();
  await pending;
});

test("setVolume() retunes a server read that is already playing", async () => {
  immediateFetch(true);
  const tts = serverTts();

  const pending = tts.speak("line", { volume: 0.2 });
  await tick();
  assert.equal(FakeAudio.instances[0].volume, 0.2);

  tts.setVolume(0.7); // ← slider moved mid-sentence
  assert.equal(FakeAudio.instances[0].volume, 0.7, "applied live, no restart");

  FakeAudio.instances[0].onended?.();
  await pending;
});

test("setVolume() retunes the live utterance and clamps what it is given", async () => {
  const tts = new BrowserTTS(); // no server engine → speechSynthesis layer
  void tts.speak("browser line", { volume: 0.3 });
  assert.equal(synthesis.spoken[0].volume, 0.3, "utterance starts at the setting");

  tts.setVolume(0.8);
  assert.equal(synthesis.spoken[0].volume, 0.8, "applied to the utterance in flight");

  tts.setVolume(5);
  assert.equal(synthesis.spoken[0].volume, 1, "values above 1 clamp to 1");

  tts.setVolume(Number.NaN);
  assert.equal(synthesis.spoken[0].volume, 1, "non-numeric input is ignored");
});

test("setVolume() with nothing playing is a safe no-op", () => {
  const tts = new BrowserTTS();
  tts.setVolume(0.4);
  assert.equal(tts._audio, null);
  assert.equal(tts._utt, null);
});

// ---------------------------------------------------------------------------
// Long token selections stay under the server's segment cap (review major #2)
// ---------------------------------------------------------------------------

test("chunkTokens: groups tokens into ≤40-word segments without dropping any", () => {
  const many = Array.from({ length: 60 }, (_, i) => `w${i}`);
  const chunks = chunkTokens(many);
  assert.equal(chunks.length, 2, "60 tokens → 40 + 20");
  assert.equal(chunks[0].split(" ").length, MAX_TOKEN_SEGMENTS);
  assert.equal(chunks[1].split(" ").length, 20);
  assert.deepEqual(chunks.join(" ").split(" "), many, "order and content preserved");

  assert.equal(chunkTokens(["only", "three"]).length, 1, "short selections stay one segment");
  assert.deepEqual(chunkTokens([]), [], "an empty selection stays empty");
});

test("a ~60-token selection is sent as two ≤40-word segments in ONE request", async () => {
  const urls: string[] = [];
  (globalThis as { fetch: unknown }).fetch = async (url: unknown) => {
    urls.push(String(url));
    return audioResponse();
  };
  const tts = serverTts();
  const tokens = Array.from({ length: 60 }, (_, i) => `word${i}`);

  const pending = tts.speak(tokens);
  await tick();

  assert.equal(urls.length, 1, "a long selection must stay a single request");
  const params = new URLSearchParams(urls[0].split("?")[1]);
  const segments = params.getAll("segments");
  assert.equal(segments.length, 2, "60 tokens must not become 60 segments (server cap is 40)");
  for (const s of segments) {
    assert.ok(s.split(" ").length <= 40, `segment over the cap: "${s}"`);
  }
  assert.deepEqual(segments.join(" ").split(" "), tokens, "no token lost or reordered");

  FakeAudio.instances[0]?.onended?.();
  await pending;
});
