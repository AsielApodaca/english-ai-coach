/**
 * Auto-start for the local Ollama server (feature 119).
 *
 * Contract:
 *   createOllamaLauncher(opts?) → OllamaLauncher
 *   OllamaLauncher.isUp()          — true when the Ollama health ping answers.
 *   OllamaLauncher.ensureRunning() — true when Ollama answers the ping, spawning
 *     `ollama serve` at most once if it does not (already running → true, no
 *     spawn). Never rejects: a missing binary, a failed spawn and a startup
 *     timeout all resolve to false.
 *   warmWithOllamaAutostart(providers, launcher) — warms the local models and,
 *     only when the warm failed BECAUSE the server is down, starts it and warms
 *     again once. Never rejects.
 *
 * Why the trigger is the warm (routes/health.ts): a warm failure with the
 * server answering the ping means the model was never pulled (`ollama pull`) —
 * launching would not help — while a failure with a dead server is exactly
 * what spawning `ollama serve` fixes. The existing `OLLAMA_WARM=0` opt-out
 * disables the warm and therefore this trigger; there is no separate setting.
 *
 * Lifecycle of the child: spawned `detached` + `unref`'d and NEVER killed by
 * this process — `ollama serve` intentionally outlives the app (and every
 * `node --watch` restart), so the next boot finds it via the ping and does not
 * spawn a duplicate. Same risk class as the other local CLIs the project spawns
 * (`whisper-cli`, `piper`): a binary resolved from PATH.
 */

import { spawn } from "node:child_process";

import { pingOllama } from "./ollama.ts";
import type { Provider } from "./types.ts";
import { warmProviders } from "./index.ts";
import { snip } from "../util/subprocess.ts";

/** Wall-clock budget for a spawned `ollama serve` to answer the health ping. */
export const OLLAMA_START_BUDGET_MS = 15_000;

/** Delay between health pings while waiting for the spawned server. */
export const OLLAMA_START_POLL_MS = 500;

/** Minimal handle the launcher needs from a spawned child (fakeable in tests). */
export interface SpawnedProcess {
  unref(): void;
  on(event: "error", listener: (err: Error) => void): unknown;
}

/** `spawn()` signature used by the launcher; injectable so tests spawn nothing. */
export type SpawnOllama = (
  command: string,
  args: string[],
  options: { detached: true; stdio: "ignore" },
) => SpawnedProcess;

export interface OllamaLauncher {
  /** True when the Ollama health ping answers right now. */
  isUp(): Promise<boolean>;
  /** Make Ollama answer the ping, spawning `ollama serve` at most once. */
  ensureRunning(): Promise<boolean>;
}

export interface OllamaLauncherOptions {
  /** Health probe (defaults to `pingOllama` against the fixed local URL). */
  ping?: () => Promise<boolean>;
  /** Process spawner (defaults to `child_process.spawn`). */
  spawn?: SpawnOllama;
  /** Startup budget in ms (tests shrink it; default {@link OLLAMA_START_BUDGET_MS}). */
  budgetMs?: number;
  /** Ping cadence while waiting, in ms (default {@link OLLAMA_START_POLL_MS}). */
  pollMs?: number;
  /** Progress/diagnostic lines (defaults to `console.log`). */
  log?: (line: string) => void;
}

/** Resolve after `ms` — the poll cadence of the startup wait. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Default spawner: `detached` so the child survives, `unref` so it does not hold the loop. */
const spawnOllamaServe: SpawnOllama = (command, args, options): SpawnedProcess =>
  spawn(command, args, options);

/**
 * Build the Ollama auto-starter.
 *
 * State (one in-flight launch/ping) lives in this closure — never at module
 * scope — so every app instance gets its own launcher and tests can build
 * several isolated ones (pattern of `warmInFlight` in routes/health.ts).
 *
 * @param opts - injectable ping/spawn and timing, for tests
 */
export function createOllamaLauncher(opts: OllamaLauncherOptions = {}): OllamaLauncher {
  const ping = opts.ping ?? (() => pingOllama());
  const spawnOllama = opts.spawn ?? spawnOllamaServe;
  const budgetMs = opts.budgetMs ?? OLLAMA_START_BUDGET_MS;
  const pollMs = opts.pollMs ?? OLLAMA_START_POLL_MS;
  const log = opts.log ?? ((line: string) => console.log(line));

  /** In-flight launch (or plain health check): concurrent callers join it. */
  let inFlight: Promise<boolean> | null = null;

  /**
   * Spawn `ollama serve` and wait until the health ping answers, the child
   * reports an error (ENOENT, EADDRINUSE, …) or the budget runs out.
   *
   * @returns true only once the server actually answers the ping
   */
  async function launch(): Promise<boolean> {
    let child: SpawnedProcess;
    try {
      child = spawnOllama("ollama", ["serve"], { detached: true, stdio: "ignore" });
    } catch (err) {
      log(`[ollama] failed to spawn \`ollama serve\`: ${snip(String(err))}`);
      return false;
    }
    // Holder object (not a plain `let`): the error arrives from a callback, and
    // reading it through a property keeps TypeScript from narrowing it away.
    const failure: { error: Error | null } = { error: null };
    child.on("error", (err) => {
      failure.error = err;
    });
    child.unref();

    log("[ollama] server not answering on localhost:11434 — starting `ollama serve`");
    const startedAt = Date.now();
    const deadline = startedAt + budgetMs;
    while (Date.now() < deadline) {
      await delay(pollMs);
      const spawnError = failure.error;
      if (spawnError) {
        const code = (spawnError as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          log("[ollama] `ollama` binary not found in PATH (install: brew install ollama)");
        } else {
          log(`[ollama] failed to start: ${snip(spawnError.message)}`);
        }
        return false;
      }
      if (await ping()) {
        log(`[ollama] ready (${Date.now() - startedAt} ms)`);
        return true;
      }
    }
    log(`[ollama] not answering after ${budgetMs} ms — giving up`);
    return false;
  }

  return {
    isUp(): Promise<boolean> {
      return ping();
    },
    ensureRunning(): Promise<boolean> {
      if (inFlight) return inFlight;
      inFlight = (async () => {
        if (await ping()) return true;
        return launch();
      })().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}

/**
 * Warm every local Ollama model, starting the server first when it is down.
 *
 * Flow: warm → if some `ollama`/`ollama-fast` warm failed:
 *   1. server answers the ping → the model is missing (`ollama pull` needed);
 *      launching would not help, keep the failure as-is;
 *   2. server is down → `launcher.ensureRunning()`; on success warm once more
 *      (so the boot warm still pre-loads the weights), on failure keep the
 *      original results.
 *
 * @param providers - full provider registry; only `ollama`/`ollama-fast` are warmed
 * @param launcher - auto-starter (injected, so tests never spawn a process)
 * @returns per-provider warm outcome keyed by provider id; never rejects
 */
export async function warmWithOllamaAutostart(
  providers: Provider[],
  launcher: OllamaLauncher,
): Promise<Record<string, boolean>> {
  const results = await warmProviders(providers);
  const localFailed = Object.entries(results).some(
    ([id, ok]) => !ok && (id === "ollama" || id === "ollama-fast"),
  );
  if (!localFailed) return results;
  if (await launcher.isUp()) return results;
  if (!(await launcher.ensureRunning())) return results;
  return warmProviders(providers);
}
