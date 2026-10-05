import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createOllamaLauncher,
  warmWithOllamaAutostart,
  OLLAMA_START_BUDGET_MS,
  OLLAMA_START_POLL_MS,
  type OllamaLauncher,
  type OllamaLauncherOptions,
  type SpawnOllama,
  type SpawnedProcess,
} from "../src/lib/providers/ollama-launch.ts";
import type { ChatMessage, CompleteOptions, Provider, ProviderId } from "../src/lib/providers/types.ts";

// ---------------------------------------------------------------------------
// Feature 119 — Ollama auto-start. Everything is faked: the ping is a closure
// and the spawner records its call, so no test here launches a process or
// touches the network.
// ---------------------------------------------------------------------------

/** Fake child process: counts `unref` and lets the test fire the error event. */
interface FakeChild {
  unrefCount: number;
  handle: SpawnedProcess;
  fireError(err: Error): void;
}

function fakeChild(): FakeChild {
  const listeners: ((err: Error) => void)[] = [];
  const child: FakeChild = {
    unrefCount: 0,
    handle: {
      unref() {
        child.unrefCount++;
      },
      on(_event: "error", listener: (err: Error) => void) {
        listeners.push(listener);
      },
    },
    fireError(err: Error) {
      for (const listener of listeners) listener(err);
    },
  };
  return child;
}

/** Everything the launcher recorded: spawn calls plus the log lines. */
interface Recorder {
  spawns: { command: string; args: string[]; options: { detached: true; stdio: "ignore" } }[];
  logs: string[];
}

function recorder(): Recorder {
  return { spawns: [], logs: [] };
}

/** Build a launcher whose ping answers `false` until `upAtPing` (default: never). */
function launcherWith(
  rec: Recorder,
  opts: { upAtPing?: number; child?: FakeChild; onSpawn?: (child: FakeChild) => void } & OllamaLauncherOptions = {},
): OllamaLauncher {
  let pings = 0;
  const child = opts.child ?? fakeChild();
  const ping = opts.ping ?? (async () => {
    pings++;
    return opts.upAtPing !== undefined && pings >= opts.upAtPing;
  });
  const spawn: SpawnOllama = (command, args, options) => {
    rec.spawns.push({ command, args, options });
    opts.onSpawn?.(child);
    return child.handle;
  };
  return createOllamaLauncher({
    ping,
    spawn,
    log: (line) => rec.logs.push(line),
    pollMs: opts.pollMs ?? 1,
    budgetMs: opts.budgetMs ?? 500,
  });
}

// ---------------------------------------------------------------------------
// createOllamaLauncher
// ---------------------------------------------------------------------------

test("ensureRunning: server already up → resolves true without spawning", async () => {
  const rec = recorder();
  const launcher = launcherWith(rec, { ping: async () => true });

  assert.equal(await launcher.isUp(), true);
  assert.equal(await launcher.ensureRunning(), true);
  assert.deepEqual(rec.spawns, []);
});

test("ensureRunning: server down → spawns `ollama serve` detached+unref, true once the ping answers", async () => {
  const rec = recorder();
  const child = fakeChild();
  // ping 1 (pre-check) fails → spawn → ping 2 fails → ping 3 answers.
  const launcher = launcherWith(rec, { child, upAtPing: 3 });

  assert.equal(await launcher.ensureRunning(), true);
  assert.deepEqual(rec.spawns, [
    { command: "ollama", args: ["serve"], options: { detached: true, stdio: "ignore" } },
  ]);
  assert.equal(child.unrefCount, 1, "the child must not hold the event loop");
  assert.ok(rec.logs.some((line) => line.includes("starting `ollama serve`")));
  assert.ok(rec.logs.some((line) => line.includes("ready")));
});

test("ensureRunning: spawn error ENOENT (no ollama binary) → false, without waiting the full budget", async () => {
  const rec = recorder();
  const child = fakeChild();
  const launcher = launcherWith(rec, {
    child,
    onSpawn: (c) => {
      // The error event fires right after spawn returns (as ENOENT does).
      queueMicrotask(() => c.fireError(Object.assign(new Error("spawn ollama ENOENT"), { code: "ENOENT" })));
    },
    budgetMs: 60_000,
  });

  const startedAt = Date.now();
  assert.equal(await launcher.ensureRunning(), false);
  assert.ok(Date.now() - startedAt < 5_000, "must bail out on the spawn error, not on the budget");
  assert.equal(rec.spawns.length, 1);
  assert.ok(rec.logs.some((line) => line.includes("binary not found in PATH")));
});

test("ensureRunning: generic spawn error → false with the snipped message", async () => {
  const rec = recorder();
  const child = fakeChild();
  const launcher = launcherWith(rec, {
    child,
    onSpawn: (c) => {
      queueMicrotask(() => c.fireError(new Error("EADDRINUSE: address already in use")));
    },
    budgetMs: 60_000,
  });

  assert.equal(await launcher.ensureRunning(), false);
  assert.ok(rec.logs.some((line) => line.includes("EADDRINUSE")));
});

test("ensureRunning: server never comes up → false after the budget, still exactly one spawn", async () => {
  const rec = recorder();
  const launcher = launcherWith(rec, { budgetMs: 30, pollMs: 2 });

  assert.equal(await launcher.ensureRunning(), false);
  assert.equal(rec.spawns.length, 1);
  assert.ok(rec.logs.some((line) => line.includes("giving up")));
});

test("ensureRunning: concurrent callers join the same launch (single spawn)", async () => {
  const rec = recorder();
  const child = fakeChild();
  let pings = 0;
  const launcher = createOllamaLauncher({
    // Stays down until the spawn happened, then answers.
    ping: async () => {
      pings++;
      return rec.spawns.length > 0;
    },
    spawn: (command, args, options) => {
      rec.spawns.push({ command, args, options });
      return child.handle;
    },
    log: (line) => rec.logs.push(line),
    pollMs: 1,
    budgetMs: 500,
  });

  const [first, second] = await Promise.all([launcher.ensureRunning(), launcher.ensureRunning()]);
  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(rec.spawns.length, 1, "the second caller must join, not spawn again");
  assert.ok(pings >= 2);
});

test("default budgets are exported as named constants", () => {
  assert.equal(OLLAMA_START_BUDGET_MS, 15_000);
  assert.equal(OLLAMA_START_POLL_MS, 500);
});

// ---------------------------------------------------------------------------
// warmWithOllamaAutostart
// ---------------------------------------------------------------------------

interface WarmState {
  calls: number;
}

/**
 * Ollama provider double whose warm outcomes follow a script (one entry per
 * warm attempt, the last one repeats) — lets a test fail the first warm and
 * succeed the re-warm after the launch.
 */
function ollamaDouble(id: ProviderId, script: boolean[]): { provider: Provider; state: WarmState } {
  let index = 0;
  const state: WarmState = { calls: 0 };
  const provider: Provider = {
    id,
    name: `fake ${id}`,
    async available() {
      return true;
    },
    async complete(_messages: ChatMessage[], _options?: CompleteOptions) {
      const ok = script[Math.min(index, script.length - 1)];
      index++;
      state.calls++;
      if (!ok) throw new Error(`${id} warm failed`);
      return "ok";
    },
  };
  return { provider, state };
}

interface LauncherState {
  isUpCalls: number;
  ensureCalls: number;
}

/** Launcher double recording how often each probe was consulted. */
function launcherDouble(behaviour: { up: boolean; start: boolean }): { launcher: OllamaLauncher; state: LauncherState } {
  const state: LauncherState = { isUpCalls: 0, ensureCalls: 0 };
  const launcher: OllamaLauncher = {
    async isUp() {
      state.isUpCalls++;
      return behaviour.up;
    },
    async ensureRunning() {
      state.ensureCalls++;
      return behaviour.start;
    },
  };
  return { launcher, state };
}

test("warm succeeds → the launcher is never consulted", async () => {
  const { provider } = ollamaDouble("ollama", [true]);
  const { launcher, state } = launcherDouble({ up: false, start: false });

  const results = await warmWithOllamaAutostart([provider], launcher);

  assert.deepEqual(results, { ollama: true });
  assert.deepEqual(state, { isUpCalls: 0, ensureCalls: 0 });
});

test("warm fails while the server answers the ping (model not pulled) → no launch, no re-warm", async () => {
  const { provider, state } = ollamaDouble("ollama", [false]);
  const { launcher, state: launcherState } = launcherDouble({ up: true, start: true });

  const results = await warmWithOllamaAutostart([provider], launcher);

  assert.deepEqual(results, { ollama: false });
  assert.equal(state.calls, 1, "launching would not fix a missing model");
  assert.deepEqual(launcherState, { isUpCalls: 1, ensureCalls: 0 });
});

test("warm fails with the server down → start it and warm once more", async () => {
  const { provider, state } = ollamaDouble("ollama", [false, true]);
  const { launcher, state: launcherState } = launcherDouble({ up: false, start: true });

  const results = await warmWithOllamaAutostart([provider], launcher);

  assert.deepEqual(results, { ollama: true }, "the re-warm is what pre-loads the weights");
  assert.equal(state.calls, 2);
  assert.deepEqual(launcherState, { isUpCalls: 1, ensureCalls: 1 });
});

test("warm fails with the server down and the launch fails → keeps the original failure", async () => {
  const { provider, state } = ollamaDouble("ollama", [false]);
  const { launcher, state: launcherState } = launcherDouble({ up: false, start: false });

  const results = await warmWithOllamaAutostart([provider], launcher);

  assert.deepEqual(results, { ollama: false });
  assert.equal(state.calls, 1, "no point re-warming a server that never started");
  assert.deepEqual(launcherState, { isUpCalls: 1, ensureCalls: 1 });
});

test("only the failing local provider triggers the launcher; the healthy warm is kept", async () => {
  const { provider: main, state: mainState } = ollamaDouble("ollama", [true]);
  const { provider: fast, state: fastState } = ollamaDouble("ollama-fast", [false, true]);
  const { launcher, state } = launcherDouble({ up: false, start: true });

  const results = await warmWithOllamaAutostart([main, fast], launcher);

  assert.deepEqual(results, { ollama: true, "ollama-fast": true }, "the re-warm recovers both");
  assert.equal(mainState.calls, 2, "the re-warm warms every local provider again");
  assert.equal(fastState.calls, 2);
  assert.deepEqual(state, { isUpCalls: 1, ensureCalls: 1 });
});

test("no local provider registered → empty results, launcher untouched", async () => {
  const remote: Provider = {
    id: "gemini",
    name: "remote double",
    async available() {
      return true;
    },
    async complete() {
      throw new Error("must not be warmed");
    },
  };
  const { launcher, state } = launcherDouble({ up: false, start: true });

  const results = await warmWithOllamaAutostart([remote], launcher);

  assert.deepEqual(results, {});
  assert.deepEqual(state, { isUpCalls: 0, ensureCalls: 0 });
});
