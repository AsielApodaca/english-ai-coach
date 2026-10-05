/**
 * Settings model: enums, types and defaults (feature 108) — split out of
 * `settings.ts` by feature 117 so the merge/parse logic has its own file.
 *
 * Pure data: the choice lists (with their derived union types), the full
 * `AppSettings` surface, `DEFAULT_SETTINGS`, the volume bounds and the
 * localStorage keys. `settings.ts` re-exports this file, so existing
 * `from "./settings.ts"` imports resolve unchanged.
 */

// ---------------------------------------------------------------------------
// Enums / choices
// ---------------------------------------------------------------------------

export const RIGOR_LEVELS = ["Flexible", "Balanceado", "Estricto"] as const;
export type RigorLevel = (typeof RIGOR_LEVELS)[number];

/** F1 pass threshold per rigor level (spec 108: Flexible >65 / Balanceado >82 / Estricto >93). */
export const RIGOR_THRESHOLDS: Record<RigorLevel, number> = {
  Flexible: 65,
  Balanceado: 82,
  Estricto: 93,
};

export const FILLER_LEVELS = ["Relajado", "Moderado", "Sensible", "Tolerancia Cero"] as const;
export type FillerLevel = (typeof FILLER_LEVELS)[number];

export const STT_CHOICES = ["auto", "whisper", "browser"] as const;
export type SttChoice = (typeof STT_CHOICES)[number];

export const TEMPO_CHOICES = [0.75, 1, 1.25] as const;

export const PROVIDER_CHOICES = ["auto", "zen", "gemini", "cloudflare", "ollama"] as const;

/** Whisper models supported by whisper.cpp (mirrors src/lib/audio/whisper.ts). */
export const WHISPER_MODELS = [
  "tiny.en",
  "base.en",
  "small.en",
  "medium.en",
  "tiny",
  "base",
  "small",
  "medium",
] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdaptiveSettings {
  enabled: boolean;
  /** Average of the last 3 scores that triggers a step up (default 90). */
  up: number;
  /** Average below which the difficulty steps down (default 65). */
  down: number;
}

/** The full settings surface (device prefs + training + persona). */
export interface AppSettings {
  mic: string;
  volume: number;
  showIpa: boolean;
  autoAdvance: boolean;
  liveHighlight: boolean;
  stt: SttChoice;
  rigor: RigorLevel;
  fillers: FillerLevel;
  tempo: number;
  adaptive: AdaptiveSettings;
  provider: string;
  whisperModel: string;
  voice: string;
  offlineMode: boolean;
  personaName: string;
  targetLevel: string;
  bio: string;
  prompt: string;
  focusPhonemes: string[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  mic: "",
  volume: 100,
  showIpa: true,
  autoAdvance: false,
  liveHighlight: true,
  stt: "auto",
  rigor: "Balanceado",
  fillers: "Moderado",
  tempo: 1,
  adaptive: { enabled: true, up: 90, down: 65 },
  provider: "auto",
  whisperModel: "small.en",
  voice: "auto",
  offlineMode: false,
  personaName: "",
  targetLevel: "B2",
  bio: "",
  prompt: "",
  focusPhonemes: [],
};

/** Lowest coach volume (percent) the UI allows — a silent coach is useless. */
export const MIN_VOLUME = 10;

/** Highest coach volume (percent). */
export const MAX_VOLUME = 100;

/** localStorage keys for the device prefs (documented in spec 108). */
export const LOCAL_SETTINGS_KEYS: Record<string, string> = {
  mic: "engcoach.mic",
  volume: "engcoach.volume",
  showIpa: "engcoach.showIpa",
  autoAdvance: "engcoach.autoAdvance",
  liveHighlight: "engcoach.liveHighlight",
  stt: "engcoach.stt",
  tempo: "engcoach.tempo",
  whisperModel: "engcoach.whisperModel",
  voice: "engcoach.voice",
};
