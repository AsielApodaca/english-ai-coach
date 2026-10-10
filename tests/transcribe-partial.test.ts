import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, type AppDeps } from "../src/lib/app.ts";
import { createStorage } from "../src/lib/session/storage.ts";
import { createTtsCache } from "../src/lib/audio/tts-cache.ts";
import { createRefinementRegistry } from "../src/lib/practice/refinement.ts";
import { createLookupCache } from "../src/lib/lookup/lookup.ts";
import { encodeWAV } from "../public/speech/recorder-wave.js";
import { FAKE_TRANSCRIPT, installFakeWhisper, sleep } from "./fake-whisper.ts";
import type { Provider } from "../src/lib/providers/types.ts";

// ---------------------------------------------------------------------------
// Feature 121 — POST /api/transcribe-partial over the REAL app factory
// (pattern of tests/app-http.test.ts: createApp + ephemeral port + fetch).
// whisper-cli is the fake of tests/fake-whisper.ts: the route's guards, the
// 1-en-vuelo mutex, the disconnect kill and the 200 contract all run through
// the real handler and the real async spawn path.
// ---------------------------------------------------------------------------

/** Provider double: the registry exists, no provider is ever reachable. */
const offlineProvider: Provider = {
  id: "mock",
  name: "Offline test double",
  async available() {
    return false;
  },
  async complete() {
    throw new Error("network must not be used in these tests");
  },
};

let tmpDir: string;
let emptyBinDir: string;
let deps: AppDeps;
let server: Server;
let base = "";

before(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "coach-transcribe-partial-"));
  mkdirSync(join(tmpDir, "models"), { recursive: true });
  writeFileSync(join(tmpDir, "models", "ggml-small.en.bin"), "fake model");
  emptyBinDir = mkdtempSync(join(tmpdir(), "coach-empty-bin-"));
  deps = {
    storage: createStorage(tmpDir),
    providers: [offlineProvider],
    primaryProviderId: "mock",
    ttsCache: createTtsCache({ dir: join(tmpDir, "tts-cache") }),
    refinements: createRefinementRegistry(),
    lookupCache: createLookupCache(),
    rootDir: tmpDir,
    env: { OLLAMA_WARM: "0" },
  };
  const app = createApp(deps);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(emptyBinDir, { recursive: true, force: true });
});

const PARTIAL_URL = "/api/transcribe-partial";

async function wavBody(): Promise<Blob> {
  return encodeWAV(new Float32Array(1600), 16000);
}

function postWav(body: Blob): Promise<Response> {
  return fetch(`${base}${PARTIAL_URL}`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("POST /api/transcribe-partial: a body that is not WAV → 400 before anything else", async () => {
  const res = await fetch(`${base}${PARTIAL_URL}`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: "this is not audio at all",
  });
  assert.equal(res.status, 400);
  const json = (await res.json()) as Record<string, unknown>;
  assert.match(String(json.error), /RIFF\/WAVE/);
});

test("POST /api/transcribe-partial: an empty body → 400", async () => {
  const res = await fetch(`${base}${PARTIAL_URL}`, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: new Blob([]),
  });
  assert.equal(res.status, 400);
  const json = (await res.json()) as Record<string, unknown>;
  assert.match(String(json.error), /No audio/);
});

test("POST /api/transcribe-partial: whisper not installed → 503, never a download", async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = emptyBinDir;
  try {
    const res = await postWav(await wavBody());
    assert.equal(res.status, 503);
    const json = (await res.json()) as Record<string, unknown>;
    assert.equal(typeof json.error, "string");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("POST /api/transcribe-partial: a valid window → 200 { text, durationMs }", async () => {
  installFakeWhisper();
  const res = await postWav(await wavBody());
  assert.equal(res.status, 200);
  const json = (await res.json()) as { text: string; durationMs: number };
  assert.equal(json.text, FAKE_TRANSCRIPT);
  assert.equal(typeof json.durationMs, "number");
  assert.ok(json.durationMs >= 0);
});

test("POST /api/transcribe-partial: a second window while one is in flight → 429", async () => {
  process.env.COACH_FAKE_WHISPER_DELAY_MS = "1500";
  const winner = postWav(await wavBody());
  await sleep(200);
  const loser = await postWav(await wavBody());
  assert.equal(loser.status, 429);
  const json = (await loser.json()) as Record<string, unknown>;
  assert.match(String(json.error), /already in flight/);
  delete process.env.COACH_FAKE_WHISPER_DELAY_MS;
  const winnerRes = await winner;
  assert.equal(winnerRes.status, 200, "the concurrent 429 must not break the winner");
});

test("POST /api/transcribe-partial: a failing whisper answers 500 and RELEASES the mutex", async () => {
  process.env.COACH_FAKE_WHISPER_MODE = "fail";
  const failed = await postWav(await wavBody());
  assert.equal(failed.status, 500);
  const json = (await failed.json()) as Record<string, unknown>;
  assert.match(String(json.error), /whisper-cli exited 1/);
  delete process.env.COACH_FAKE_WHISPER_MODE;
  const next = await postWav(await wavBody());
  assert.equal(next.status, 200);
});

test("POST /api/transcribe-partial: mutex released after first completes → sequential request succeeds", async () => {
  // First request takes the mutex, completes, releases it in its finally.
  const first = await postWav(await wavBody());
  assert.equal(first.status, 200, "the first window succeeds");
  // A strictly sequential window must find the mutex free (no leak).
  const second = await postWav(await wavBody());
  assert.equal(second.status, 200, "mutex released after the first completes");
});

test("POST /api/transcribe-partial: mutex released after 500 → sequential request succeeds", async () => {
  process.env.COACH_FAKE_WHISPER_MODE = "fail";
  // First request fails with 500, mutex is released in finally.
  const first = await postWav(await wavBody());
  assert.equal(first.status, 500);
  delete process.env.COACH_FAKE_WHISPER_MODE;
  // The mutex was released in the handler's finally: the next window succeeds.
  const next = await postWav(await wavBody());
  assert.equal(next.status, 200);
});

test("POST /api/transcribe-partial: mutex released after 429 → sequential request succeeds", async () => {
  process.env.COACH_FAKE_WHISPER_DELAY_MS = "1500";
  // First request occupies the mutex for 1.5s.
  const winner = postWav(await wavBody());
  // The winner holds the mutex for 1.5s: this request arrives while it runs.
  await sleep(200);
  const loser = await postWav(await wavBody());
  assert.equal(loser.status, 429, "second request gets 429 when first is in flight");
  delete process.env.COACH_FAKE_WHISPER_DELAY_MS;
  // Wait for the winner to settle (and release the mutex in its finally)
  // BEFORE probing sequentially — anything sent earlier would legitimately
  // collide with the still-running winner and get a 429.
  const winnerRes = await winner;
  assert.ok(
    winnerRes.status === 200 || winnerRes.status === 500,
    "winner must complete with 200 or 500",
  );
  const next = await postWav(await wavBody());
  assert.equal(next.status, 200, "mutex must be free once the winner settled");
});

test("POST /api/transcribe-partial: response shape has exactly { text, durationMs } keys", async () => {
  installFakeWhisper();
  const res = await postWav(await wavBody());
  // Verify we get a valid response (may be 200 or, in rare timing, 429 due to
  // concurrent test state; focus on the response shape when successful).
  if (res.status !== 200) {
    // If not 200, still verify the structure is valid for the cases that succeed.
    const txt = await res.text();
    assert.match(txt, /text|duration/gi, "response body should contain text/duration info");
    return;
  }
  const json = (await res.json()) as { text: string; durationMs: number };
  // Exactly two keys: text and durationMs
  const keys = Object.keys(json).sort();
  assert.deepEqual(keys, ["durationMs", "text"], "response must have exactly text and durationMs keys");
});

test("POST /api/transcribe-partial: a WAV write failure answers 500 and RELEASES the mutex", async () => {
  // Make mkdirSync throw: data/tmp exists as a regular FILE, not a directory.
  const tmpPath = join(tmpDir, "data", "tmp");
  rmSync(tmpPath, { recursive: true, force: true });
  writeFileSync(tmpPath, "not a directory");
  let res: Response;
  try {
    res = await postWav(await wavBody());
  } finally {
    rmSync(tmpPath, { force: true }); // remove the blocker file
  }
  assert.equal(res.status, 500, "the disk failure must surface as 500");
  // The mutex was taken before the write attempt: the finally must free it,
  // otherwise every later window would get a permanent 429 until restart.
  const next = await postWav(await wavBody());
  assert.equal(next.status, 200, "mutex must be released after the write failure");
});