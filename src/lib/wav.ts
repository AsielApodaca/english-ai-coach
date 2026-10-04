/**
 * RIFF/WAVE header validation for uploaded recordings (feature 117).
 *
 * Contract:
 *   isWavBuffer(buf: Uint8Array): boolean
 *     true  — the buffer starts with a plausible RIFF/WAVE header
 *     false — anything else (JSON, HTML, truncated garbage, MP3…)
 *
 * Why: `POST /api/transcribe` wrote the request body to disk and spawned
 * `whisper-cli` on it without checking the format first — a non-WAV body
 * produced a confusing subprocess failure (500) after touching the disk. The
 * guard runs BEFORE the temp file is created, so a bad upload is a clean
 * 400 { error }.
 *
 * Deliberately shallow: it verifies the two magic markers every RIFF/WAVE
 * file starts with plus the 44-byte minimum size of the canonical PCM header.
 * It does not parse fmt/data chunks (whisper.cpp does that and reports real
 * decode problems itself).
 */

/** Bytes of the canonical 16-bit PCM header (RIFF…data size field inclusive). */
const MIN_WAV_HEADER_BYTES = 44;

/**
 * Whether `buf` looks like a RIFF/WAVE audio file.
 *
 * Checks bytes 0..4 "RIFF", bytes 8..12 "WAVE" and a length of at least the
 * 44-byte canonical header. Operates on latin1 (byte → char) so the check
 * never depends on the text encoding of the runtime.
 */
export function isWavBuffer(buf: Uint8Array): boolean {
  if (buf.length < MIN_WAV_HEADER_BYTES) return false;
  return readTag(buf, 0, 4) === "RIFF" && readTag(buf, 8, 4) === "WAVE";
}

/** Read `length` bytes at `offset` as latin1 characters (byte-exact). */
function readTag(buf: Uint8Array, offset: number, length: number): string {
  let out = "";
  for (let i = offset; i < offset + length; i++) out += String.fromCharCode(buf[i]);
  return out;
}
