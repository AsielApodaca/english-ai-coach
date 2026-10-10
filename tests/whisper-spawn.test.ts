import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { transcribeWav, transcribeWords } from "../src/lib/audio/whisper.ts";
import { FAKE_TRANSCRIPT, installFakeWhisper, sleep } from "./fake-whisper.ts";

// ---------------------------------------------------------------------------
// Feature 121 — the async spawn migration of whisper-cli. The binary is the
// fake of tests/fake-whisper.ts (installed at the FRONT of PATH before the
// first findBinary call of this process, whose success is memoized): these
// tests drive the REAL async runWhisper path (spawn, timeout kill, abort
// kill, unique outPrefix) without a model or a real whisper install.
// ---------------------------------------------------------------------------

let tmpDir: string;
let baseDir: string;
let wavPath: string;
/** Log file collecting every `-of` prefix the fake children received. */
let prefixLog: string;

before(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "coach-whisper-spawn-"));
  baseDir = join(tmpDir, "base");
  mkdirSync(baseDir, { recursive: true });
  wavPath = join(tmpDir, "sample.wav");
  // transcribeWav never reads the WAV itself (the fake ignores -f), but the
  // path must exist for the call to look realistic.
  writeFileSync(wavPath, Buffer.alloc(44));
  prefixLog = join(tmpDir, "prefixes.log");
  installFakeWhisper();
  process.env.COACH_FAKE_WHISPER_PREFIX_LOG = prefixLog;
});

after(() => {
  delete process.env.COACH_FAKE_WHISPER_PREFIX_LOG;
  delete process.env.COACH_FAKE_WHISPER_MODE;
  delete process.env.COACH_FAKE_WHISPER_DELAY_MS;
  delete process.env.COACH_FAKE_WHISPER_MARKER;
  rmSync(tmpDir, { recursive: true, force: true });
});

test("transcribeWav: resolves { text, durationMs } without blocking the event loop", async () => {
  // The whole point of the migration: the event loop keeps turning WHILE the
  // child runs. With the old spawnSync every tick below would starve.
  process.env.COACH_FAKE_WHISPER_DELAY_MS = "400";
  let ticks = 0;
  const iv = setInterval(() => ticks++, 25);
  try {
    const result = await transcribeWav(wavPath, "ggml-fake.bin", baseDir);
    assert.equal(result.text, FAKE_TRANSCRIPT);
    assert.ok(result.durationMs >= 400, `durationMs must cover the run, got ${result.durationMs}`);
  } finally {
    clearInterval(iv);
    delete process.env.COACH_FAKE_WHISPER_DELAY_MS;
  }
  assert.ok(ticks >= 5, `the event loop must keep running during transcription (got ${ticks} ticks)`);
});

test("transcribeWav: every run gets a unique whisper-<uuid> outPrefix", async () => {
  const raw = readFileSync(prefixLog, "utf8").trim().split("\n");
  assert.ok(raw.length >= 1, "the fake must have logged its -of prefixes");
  const names = raw.map((p) => p.split("/").pop()!);
  for (const name of names) {
    assert.match(name, /^whisper-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  }
  assert.equal(new Set(names).size, names.length, "concurrent/consecutive runs must never collide");

  // One more run, then compare: Date.now() (the old prefix) could collide
  // under concurrency; a uuid cannot.
  await transcribeWav(wavPath, "ggml-fake.bin", baseDir);
  const names2 = readFileSync(prefixLog, "utf8").trim().split("\n").map((p) => p.split("/").pop()!);
  assert.equal(new Set(names2).size, names2.length);
  assert.ok(names2.every((n) => n.startsWith("whisper-")));
  // The temp output files are cleaned up by transcribeWav itself.
  assert.ok(!existsSync(join(baseDir, "data", "tmp", `${names2[names2.length - 1]}.txt`)));
});

test("transcribeWav: a run over its timeout budget is killed and rejects", async () => {
  process.env.COACH_FAKE_WHISPER_DELAY_MS = "8000";
  const started = Date.now();
  await assert.rejects(
    transcribeWav(wavPath, "ggml-fake.bin", baseDir, "en", { timeoutMs: 200 }),
    /timed out after 200ms/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 3000, `the timeout must kill the child promptly (took ${elapsed}ms)`);
  delete process.env.COACH_FAKE_WHISPER_DELAY_MS;
});

test("transcribeWav: aborting the signal kills the child (client disconnect)", async () => {
  process.env.COACH_FAKE_WHISPER_DELAY_MS = "8000";
  const marker = join(tmpDir, "abort.marker");
  process.env.COACH_FAKE_WHISPER_MARKER = marker;
  // Boot handshake: the marker is written by the child's SIGTERM handler, so
  // the abort must land AFTER the child booted. A SIGTERM during Node startup
  // (possible under parallel test load) kills it without the handler ever
  // running, and the marker would never appear. The fake logs its `-of` value
  // at boot — a dedicated log file is this child's "I'm ready" signal.
  const bootLog = join(tmpDir, "abort-boot.log");
  rmSync(bootLog, { force: true });
  process.env.COACH_FAKE_WHISPER_PREFIX_LOG = bootLog;
  const controller = new AbortController();
  const pending = transcribeWav(wavPath, "ggml-fake.bin", baseDir, "en", {
    timeoutMs: 30_000,
    signal: controller.signal,
  });
  const bootDeadline = Date.now() + 10_000;
  while (!existsSync(bootLog) && Date.now() < bootDeadline) await sleep(25);
  assert.ok(existsSync(bootLog), "the child must boot before the abort is simulated");
  controller.abort();
  await assert.rejects(pending, /aborted/);
  const deadline = Date.now() + 5000;
  while (!existsSync(marker) && Date.now() < deadline) await sleep(50);
  assert.ok(existsSync(marker), "the child must receive the kill (SIGTERM) on abort");
  delete process.env.COACH_FAKE_WHISPER_MARKER;
  delete process.env.COACH_FAKE_WHISPER_DELAY_MS;
  process.env.COACH_FAKE_WHISPER_PREFIX_LOG = prefixLog; // restore the file-wide log
});

test("transcribeWav: a non-zero exit rejects with status + stderr (same as before)", async () => {
  process.env.COACH_FAKE_WHISPER_MODE = "fail";
  try {
    await assert.rejects(
      transcribeWav(wavPath, "ggml-fake.bin", baseDir),
      /whisper-cli exited 1: fake whisper failure/,
    );
  } finally {
    delete process.env.COACH_FAKE_WHISPER_MODE;
  }
});

test("transcribeWords: shares the async spawn path and resolves the words shape", async () => {
  // The fake only writes the .txt, so the JSON side is empty — the contract
  // that must hold is the resolved shape and the cleanup of temp files.
  const result = await transcribeWords(wavPath, "ggml-fake.bin", baseDir);
  assert.equal(typeof result.durationMs, "number");
  assert.ok(Array.isArray(result.words));
  const leftovers = readdirSync(join(baseDir, "data", "tmp")).filter((f) => f.endsWith(".json"));
  assert.deepEqual(leftovers, [], "the .json output must be cleaned up");
});
