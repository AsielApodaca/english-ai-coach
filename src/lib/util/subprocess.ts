/**
 * Shared spawn budgets for the local CLI tools (feature 117).
 *
 * `whisper-cli`, `piper` and `edge-tts` are all spawned with the same three
 * literals (`timeout: 60_000`, `maxBuffer: 10 * 1024 * 1024` and a
 * `stderr.slice(0, 500)` when the tool fails). They now live here, next to
 * the `snip()` helper that shortens stderr for error messages, so the budgets
 * are defined exactly once and greppable in one place.
 *
 * Contract for consumers: pass these to `spawnSync` options and build error
 * messages with `snip(res.stderr)` — never with a hand-rolled `slice`.
 */

/** Wall-clock budget for one synchronous CLI call (whisper/piper/edge-tts). */
export const SUBPROCESS_TIMEOUT_MS = 60_000;

/** Max stdout+stderr a CLI call may buffer before the spawn fails (10 MiB). */
export const SUBPROCESS_MAX_BUFFER = 10 * 1024 * 1024;

/** Chars of stderr kept in a CLI error message (the rest is noise). */
export const STDERR_SNIP_LEN = 500;

/**
 * Shorten a CLI's stderr for an error message.
 *
 * @param text - stderr of the failed spawn (may be null/undefined when the
 *   process never produced output)
 * @param maxLen - characters to keep (defaults to {@link STDERR_SNIP_LEN})
 * @returns the first `maxLen` characters, or "" for nullish input
 */
export function snip(text: string | null | undefined, maxLen: number = STDERR_SNIP_LEN): string {
  return (text ?? "").slice(0, maxLen);
}
