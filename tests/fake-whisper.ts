/**
 * Fake `whisper-cli` for the feature-121 spawn tests (helper, NOT a test file:
 * the `tests/*.test.ts` glob does not pick it up).
 *
 * `installFakeWhisper()` drops an executable `whisper-cli` (a Node script) at
 * the FRONT of `process.env.PATH`, so `findBinary()` resolves it instead of
 * the real Homebrew binary. The fake parses the `-of <prefix>` argument the
 * way whisper-cli does and writes `<prefix>.txt` after a configurable delay —
 * enough to drive `transcribeWav` and `POST /api/transcribe-partial` through
 * the real async spawn path, without a model or a real whisper install.
 *
 * Environment knobs (read by the fake child at spawn time):
 *   COACH_FAKE_WHISPER_MODE        "ok" (default) | "fail" (exit 1)
 *   COACH_FAKE_WHISPER_DELAY_MS    sleep before answering (default 0)
 *   COACH_FAKE_WHISPER_PREFIX_LOG  file to append every `-of` value to
 *   COACH_FAKE_WHISPER_MARKER      file to write when the child is SIGTERMed
 *                                  (kill-on-timeout / kill-on-disconnect tests)
 */

import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Transcript the fake emits (both the .txt and the tests' expectation). */
export const FAKE_TRANSCRIPT = "I handled the situation";

const SCRIPT = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const ofIndex = args.indexOf("-of");
const prefix = ofIndex >= 0 ? args[ofIndex + 1] : "";
const mode = process.env.COACH_FAKE_WHISPER_MODE || "ok";
const log = process.env.COACH_FAKE_WHISPER_PREFIX_LOG;
if (log) fs.appendFileSync(log, prefix + "\\n");
const marker = process.env.COACH_FAKE_WHISPER_MARKER;
if (marker) {
  process.on("SIGTERM", () => {
    fs.writeFileSync(marker, "killed");
    process.exit(143);
  });
}
const delayMs = Number(process.env.COACH_FAKE_WHISPER_DELAY_MS || 0);
setTimeout(() => {
  if (mode === "fail") {
    console.error("fake whisper failure");
    process.exit(1);
  }
  fs.writeFileSync(prefix + ".txt", ${JSON.stringify(`${FAKE_TRANSCRIPT}\n`)});
  process.exit(0);
}, delayMs);
`;

export interface FakeWhisperInstall {
  /** Directory holding the fake binary (already prepended to PATH). */
  binDir: string;
  /** Restore the original PATH (some tests point it elsewhere). */
  restore: () => void;
}

/**
 * Install the fake `whisper-cli` at the front of PATH. Call it BEFORE the
 * first `findBinary()` of the process (a successful lookup is memoized).
 */
export function installFakeWhisper(): FakeWhisperInstall {
  const binDir = mkdtempSync(join(tmpdir(), "coach-fake-whisper-"));
  const bin = join(binDir, "whisper-cli");
  writeFileSync(bin, SCRIPT);
  chmodSync(bin, 0o755);
  const original = process.env.PATH ?? "";
  process.env.PATH = `${binDir}:${original}`;
  return {
    binDir,
    restore: () => {
      process.env.PATH = original;
    },
  };
}

/** Resolve after `ms` (test pacing helper). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
