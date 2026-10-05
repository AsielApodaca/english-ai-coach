/**
 * Adaptive difficulty (spec 107) — split out of `continuous.ts` by feature 117.
 *
 * The average of the last 3 full-answer scores steps the level and the rigor
 * up or down, each axis clamping independently (A1–C2 / Flexible–Estricto),
 * and returns the pill message for the UI. Pure: no I/O, no network.
 */

import { LEVELS, type Level, type SessionV2 } from "./session/storage.ts";
import { RIGOR_LEVELS, type AdaptiveSettings, type RigorLevel } from "./settings.ts";

// ---------------------------------------------------------------------------
// Rolling scores (adaptive difficulty)
// ---------------------------------------------------------------------------

/** The last `n` full-answer scores of a session (spec 107: last 3). */
export function rollingScores(session: SessionV2, n = 3): number[] {
  return session.questions
    .map((q) => q.eval?.score)
    .filter((s): s is number => typeof s === "number")
    .slice(-n);
}

/** Arithmetic mean of the rolling scores (0 when empty). */
export function rollingAverage(scores: number[]): number {
  if (scores.length === 0) return 0;
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

/** Result of the adaptive step: the new level/rigor plus the UI pill message. */
export interface AdaptiveResult {
  level: Level;
  rigor: RigorLevel;
  /** Pill message for the UI (e.g. "Dificultad sube a B2 · rigor Estricto"); null when nothing changes. */
  message: string | null;
}

/**
 * Step the difficulty from the rolling scores (spec 107):
 *   - avg(last 3) >= adaptive.up (default 90) → step level AND rigor up;
 *   - avg < adaptive.down (default 65) → step both down;
 *   - otherwise (or with fewer than 3 scores, or adaptive disabled) → no change.
 *
 * Each axis clamps independently (A1–C2 / Flexible–Estricto), so when one axis
 * is already at its max/min the message only mentions the axis that moved.
 * Pure and unit-testable without network.
 */
export function computeAdaptive(
  rolling: number[],
  current: { level: Level; rigor: RigorLevel },
  adaptive: AdaptiveSettings,
): AdaptiveResult {
  const levelIdx = LEVELS.indexOf(current.level);
  const rigorIdx = RIGOR_LEVELS.indexOf(current.rigor);
  if (rolling.length < 3 || !adaptive.enabled || levelIdx === -1 || rigorIdx === -1) {
    return { level: current.level, rigor: current.rigor, message: null };
  }
  const avg = rollingAverage(rolling);
  if (avg >= adaptive.up) {
    const nextLevel = LEVELS[Math.min(LEVELS.length - 1, levelIdx + 1)];
    const nextRigor = RIGOR_LEVELS[Math.min(RIGOR_LEVELS.length - 1, rigorIdx + 1)];
    return { level: nextLevel, rigor: nextRigor, message: adaptiveMessage("up", nextLevel, nextRigor, current) };
  }
  if (avg < adaptive.down) {
    const nextLevel = LEVELS[Math.max(0, levelIdx - 1)];
    const nextRigor = RIGOR_LEVELS[Math.max(0, rigorIdx - 1)];
    return { level: nextLevel, rigor: nextRigor, message: adaptiveMessage("down", nextLevel, nextRigor, current) };
  }
  return { level: current.level, rigor: current.rigor, message: null };
}

/** Build the pill message; null when neither axis actually moved. */
function adaptiveMessage(
  direction: "up" | "down",
  nextLevel: Level,
  nextRigor: RigorLevel,
  current: { level: Level; rigor: RigorLevel },
): string | null {
  const verb = direction === "up" ? "sube" : "baja";
  const levelChanged = nextLevel !== current.level;
  const rigorChanged = nextRigor !== current.rigor;
  if (levelChanged && rigorChanged) {
    // Spec 107 pill: "Dificultad sube a B2 · rigor Estricto"
    return `Dificultad ${verb} a ${nextLevel} · rigor ${nextRigor}`;
  }
  if (levelChanged) return `Dificultad ${verb} a ${nextLevel}`;
  if (rigorChanged) return `Rigor ${verb} a ${nextRigor}`;
  return null;
}
