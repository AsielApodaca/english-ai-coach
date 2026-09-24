// ---------------------------------------------------------------------------
// Settings model (feature 108) — pure, side-effect free.
//
// Owns the typed settings surface, the defaults and the merge with explicit
// precedence:
//
//   settingsSnapshot of the session (102) > localStorage device prefs >
//   profile.json settings > code defaults
//
// Device prefs (mic, volume, showIpa, autoAdvance, liveHighlight, stt, tempo,
// whisperModel, voice) live in localStorage under `engcoach.*`; training and
// persona settings (rigor, fillers, adaptive, provider, persona,
// prompt, focusPhonemes) live in `profile.json`. The server reads the profile
// to build the session snapshot at creation time (103); the frontend keeps the
// device prefs in localStorage.
// ---------------------------------------------------------------------------

import { isLevel, type Profile, type ProfileSettings, type SettingsSnapshot } from "./storage.ts";

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

/** Whisper models supported by whisper.cpp (mirrors src/lib/whisper.ts). */
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

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

export function isRigor(v: unknown): v is RigorLevel {
  return typeof v === "string" && (RIGOR_LEVELS as readonly string[]).includes(v);
}

export function isFillerLevel(v: unknown): v is FillerLevel {
  return typeof v === "string" && (FILLER_LEVELS as readonly string[]).includes(v);
}

export function isSttChoice(v: unknown): v is SttChoice {
  return typeof v === "string" && (STT_CHOICES as readonly string[]).includes(v);
}

export function isTempo(v: unknown): v is number {
  return typeof v === "number" && (TEMPO_CHOICES as readonly number[]).includes(v);
}

export function isProviderChoice(v: unknown): v is string {
  return typeof v === "string" && (PROVIDER_CHOICES as readonly string[]).includes(v);
}

export function isWhisperModel(v: unknown): v is string {
  return typeof v === "string" && (WHISPER_MODELS as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Coercion helpers (localStorage stores strings; the API may send either)
// ---------------------------------------------------------------------------

function toBool(v: unknown): boolean | null {
  if (typeof v === "boolean") return v;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return null;
}

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Parse the raw localStorage device prefs into typed settings. */
export function parseLocalSettings(raw: Record<string, unknown>): Partial<AppSettings> {
  const out: Partial<AppSettings> = {};
  if (typeof raw.mic === "string") out.mic = raw.mic;
  const volume = toFiniteNumber(raw.volume);
  if (volume !== null) out.volume = Math.max(0, Math.min(100, volume));
  const showIpa = toBool(raw.showIpa);
  if (showIpa !== null) out.showIpa = showIpa;
  const autoAdvance = toBool(raw.autoAdvance);
  if (autoAdvance !== null) out.autoAdvance = autoAdvance;
  const liveHighlight = toBool(raw.liveHighlight);
  if (liveHighlight !== null) out.liveHighlight = liveHighlight;
  if (isSttChoice(raw.stt)) out.stt = raw.stt;
  const tempo = toFiniteNumber(raw.tempo);
  if (tempo !== null && isTempo(tempo)) out.tempo = tempo;
  if (isWhisperModel(raw.whisperModel)) out.whisperModel = raw.whisperModel;
  if (typeof raw.voice === "string") out.voice = raw.voice;
  return out;
}

/** Parse the profile-persisted settings (training + persona) from a raw object. */
export function parseProfileSettings(raw: Record<string, unknown>): Partial<AppSettings> {
  const out: Partial<AppSettings> = {};
  if (isRigor(raw.rigor)) out.rigor = raw.rigor;
  if (isFillerLevel(raw.fillers)) out.fillers = raw.fillers;
  if (raw.adaptive && typeof raw.adaptive === "object") {
    const a = raw.adaptive as Record<string, unknown>;
    out.adaptive = {
      enabled: typeof a.enabled === "boolean" ? a.enabled : DEFAULT_SETTINGS.adaptive.enabled,
      up: typeof a.up === "number" ? a.up : DEFAULT_SETTINGS.adaptive.up,
      down: typeof a.down === "number" ? a.down : DEFAULT_SETTINGS.adaptive.down,
    };
  }
  if (isProviderChoice(raw.provider)) out.provider = raw.provider;
  if (typeof raw.personaName === "string") out.personaName = raw.personaName;
  if (typeof raw.targetLevel === "string" && isLevel(raw.targetLevel)) out.targetLevel = raw.targetLevel;
  if (typeof raw.bio === "string") out.bio = raw.bio;
  if (typeof raw.prompt === "string") out.prompt = raw.prompt;
  if (Array.isArray(raw.focusPhonemes)) {
    out.focusPhonemes = raw.focusPhonemes.filter((p): p is string => typeof p === "string");
  }
  return out;
}

/** Extract the profile-persisted settings from a profile object. */
export function profileSettings(profile: { settings?: ProfileSettings; focusPhonemes?: string[] }): Partial<AppSettings> {
  const out = parseProfileSettings((profile.settings ?? {}) as Record<string, unknown>);
  if (Array.isArray(profile.focusPhonemes)) {
    out.focusPhonemes = profile.focusPhonemes.filter((p): p is string => typeof p === "string");
  }
  return out;
}

/** Read the settings captured in a session snapshot (feature 102). */
export function readSnapshotSettings(snapshot?: SettingsSnapshot): Partial<AppSettings> {
  const overrides = snapshot?.overrides ?? {};
  const out: Partial<AppSettings> = {};
  if (isRigor(overrides.rigor)) out.rigor = overrides.rigor;
  if (isFillerLevel(overrides.fillers)) out.fillers = overrides.fillers;
  if (overrides.adaptive && typeof overrides.adaptive === "object") {
    const a = overrides.adaptive as Record<string, unknown>;
    out.adaptive = {
      enabled: typeof a.enabled === "boolean" ? a.enabled : DEFAULT_SETTINGS.adaptive.enabled,
      up: typeof a.up === "number" ? a.up : DEFAULT_SETTINGS.adaptive.up,
      down: typeof a.down === "number" ? a.down : DEFAULT_SETTINGS.adaptive.down,
    };
  }
  if (isProviderChoice(overrides.provider)) out.provider = overrides.provider;
  if (typeof overrides.autoAdvance === "boolean") out.autoAdvance = overrides.autoAdvance;
  return out;
}

// ---------------------------------------------------------------------------
// Merge + snapshot
// ---------------------------------------------------------------------------

/**
 * Merge settings with explicit precedence:
 * snapshot (session) > local (localStorage) > profile (profile.json) > defaults.
 */
export function mergeSettings(params: {
  snapshot?: SettingsSnapshot;
  local?: Partial<AppSettings>;
  profile?: Partial<AppSettings>;
}): AppSettings {
  const { snapshot, local, profile } = params;
  const merged: AppSettings = { ...DEFAULT_SETTINGS };
  if (profile) Object.assign(merged, profile);
  if (local) Object.assign(merged, local);
  if (snapshot) Object.assign(merged, readSnapshotSettings(snapshot));
  // `adaptive` is an object: deep-merge instead of wholesale replace. The
  // snapshot's adaptive is read RAW (not via readSnapshotSettings, which fills
  // defaults) so a partial snapshot like { enabled: false } only overrides the
  // keys it actually carries.
  merged.adaptive = {
    ...DEFAULT_SETTINGS.adaptive,
    ...(profile?.adaptive ?? {}),
    ...(local?.adaptive ?? {}),
    ...(snapshot?.overrides?.adaptive && typeof snapshot.overrides.adaptive === "object"
      ? (snapshot.overrides.adaptive as Partial<AdaptiveSettings>)
      : {}),
  };
  return merged;
}

/**
 * Build the session settings snapshot (feature 102/108). Always writes the
 * training keys so the session is self-contained: rigor, fillers, adaptive,
 * provider, autoAdvance and the derived passThreshold.
 */
export function buildSettingsSnapshot(settings: AppSettings): SettingsSnapshot {
  return {
    version: 1,
    overrides: {
      rigor: settings.rigor,
      fillers: settings.fillers,
      adaptive: { ...settings.adaptive },
      provider: settings.provider,
      autoAdvance: settings.autoAdvance,
      passThreshold: RIGOR_THRESHOLDS[settings.rigor],
    },
  };
}

/** Read the auto-advance flag captured in a session snapshot. */
export function readAutoAdvance(snapshot?: SettingsSnapshot): boolean {
  const v = snapshot?.overrides?.autoAdvance;
  return typeof v === "boolean" ? v : DEFAULT_SETTINGS.autoAdvance;
}

/**
 * Persist the profile-persisted settings (training + persona) into a profile
 * object. Idempotent: missing fields fall back to the previous profile values.
 */
export function applyProfileSettings(profile: Profile, settings: Partial<AppSettings>): Profile {
  const prev = profile.settings ?? {};
  return {
    ...profile,
    settings: {
      rigor: settings.rigor ?? prev.rigor,
      fillers: settings.fillers ?? prev.fillers,
      adaptive: settings.adaptive
        ? {
            enabled: typeof settings.adaptive.enabled === "boolean" ? settings.adaptive.enabled : DEFAULT_SETTINGS.adaptive.enabled,
            up: typeof settings.adaptive.up === "number" ? settings.adaptive.up : DEFAULT_SETTINGS.adaptive.up,
            down: typeof settings.adaptive.down === "number" ? settings.adaptive.down : DEFAULT_SETTINGS.adaptive.down,
          }
        : prev.adaptive,
      provider: settings.provider ?? prev.provider,
      personaName: settings.personaName ?? prev.personaName,
      targetLevel: settings.targetLevel ?? prev.targetLevel,
      bio: settings.bio ?? prev.bio,
      prompt: settings.prompt ?? prev.prompt,
    },
    ...(Array.isArray(settings.focusPhonemes) ? { focusPhonemes: settings.focusPhonemes } : {}),
  };
}