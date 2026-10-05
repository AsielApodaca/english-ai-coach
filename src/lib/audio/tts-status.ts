/**
 * TTS engine status plus the query-param helpers shared by the TTS routes
 * (features 007/114; extracted from server.ts by feature 117 so the route
 * modules stay thin and this logic is unit-testable without a port).
 *
 * Contracts (all pure; no I/O beyond the engine probes):
 *   ttsStatus(env, rootDir) : TtsStatus — active engine + readiness payload
 *                             served by GET /api/tts/status and embedded in
 *                             GET /api/health's `tts` field.
 *   clampNumber(value, min, max, fallback) : number — bounded numeric parse.
 *   queryList(value)        : string[] — repeatable query param as a list.
 *
 * `env` is read here (not at module scope) so every caller decides the
 * OFFLINE_MODE answer from the same source — feature 006 forces the local
 * stack when `OFFLINE_MODE=1|true`.
 */

import { checkEdgeTts, DEFAULT_EDGE_VOICE } from "./edge-tts.ts";
import { checkPiper, isVoiceReady, SUPPORTED_VOICES } from "./piper.ts";

/** Readiness payload of the TTS subsystem (features 007/114). */
export interface TtsStatus {
  /** Active engine, or null when the browser must use speechSynthesis. */
  engine: "piper" | "edge-tts" | null;
  /** True when the whole stack is local (OFFLINE_MODE). */
  offline: boolean;
  piper: {
    available: boolean;
    voiceReady: boolean;
    voice: string;
    hint: string;
    /** Every supported voice id (settings select offers `readyVoices`). */
    voices: readonly string[];
    /** Voices already downloaded — picking one can never 400 /api/tts. */
    readyVoices: string[];
  };
  edge: {
    available: boolean;
    voice: string;
    hint: string;
  };
}

/**
 * Resolve the active TTS engine and return a combined status payload.
 *
 * Engine resolution:
 *   - Piper (local) is preferred whenever binary + voice model are present.
 *   - edge-tts (online) is used only when Piper is missing AND the server is
 *     not in OFFLINE_MODE (feature 006 forces the local stack).
 *   - Otherwise no server engine is available and the browser must fall back
 *     to `speechSynthesis`.
 *
 * `piper.voices` lists every supported voice id; `piper.readyVoices` only the
 * ones already downloaded — the settings select (feature 114) offers those so
 * picking a voice can never 400 the TTS route.
 *
 * @param env - process environment (reads OFFLINE_MODE)
 * @param rootDir - project root (models/voices live under it)
 */
export function ttsStatus(env: NodeJS.ProcessEnv, rootDir: string): TtsStatus {
  const offline = env.OFFLINE_MODE === "1" || env.OFFLINE_MODE === "true";
  const piper = checkPiper(rootDir);
  const edge = checkEdgeTts();
  let engine: "piper" | "edge-tts" | null = null;
  if (piper.available && piper.voiceReady) {
    engine = "piper";
  } else if (!offline && edge.available) {
    engine = "edge-tts";
  }
  return {
    engine,
    offline,
    piper: {
      available: piper.available,
      voiceReady: piper.voiceReady,
      voice: piper.voiceName,
      hint: piper.hint,
      voices: SUPPORTED_VOICES,
      readyVoices: SUPPORTED_VOICES.filter((v) => isVoiceReady(rootDir, v)),
    },
    edge: {
      available: edge.available,
      voice: DEFAULT_EDGE_VOICE,
      hint: edge.hint,
    },
  };
}

/**
 * Parse a numeric query param within bounds, falling back to `fallback`.
 * Non-finite values (absent, "", "abc") return `fallback`; finite values are
 * clamped to `[min, max]`.
 */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Read a repeatable query param as a string list (Express gives string|string[]). */
export function queryList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value) return [value];
  return [];
}
