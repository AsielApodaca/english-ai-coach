import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_SETTINGS,
  RIGOR_THRESHOLDS,
  applyProfileSettings,
  buildSettingsSnapshot,
  mergeSettings,
  parseLocalSettings,
  parseProfileSettings,
  profileSettings,
  readAutoAdvance,
  readPrepTime,
  readSnapshotSettings,
} from "../src/lib/settings.ts";
import type { Profile } from "../src/lib/storage.ts";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

test("settings: defaults match spec 108", () => {
  assert.equal(DEFAULT_SETTINGS.rigor, "Balanceado");
  assert.equal(DEFAULT_SETTINGS.fillers, "Moderado");
  assert.equal(DEFAULT_SETTINGS.prepTime, 3);
  assert.equal(DEFAULT_SETTINGS.provider, "auto");
  assert.equal(DEFAULT_SETTINGS.whisperModel, "small.en");
  assert.equal(DEFAULT_SETTINGS.voice, "auto");
  assert.equal(DEFAULT_SETTINGS.autoAdvance, false);
  assert.equal(DEFAULT_SETTINGS.showIpa, true);
  assert.equal(DEFAULT_SETTINGS.liveHighlight, true);
  assert.deepEqual(DEFAULT_SETTINGS.adaptive, { enabled: true, up: 90, down: 65 });
  assert.deepEqual(RIGOR_THRESHOLDS, { Flexible: 65, Balanceado: 82, Estricto: 93 });
});

// ---------------------------------------------------------------------------
// parseLocalSettings (localStorage stores strings)
// ---------------------------------------------------------------------------

test("settings: parseLocalSettings coerces string values", () => {
  const parsed = parseLocalSettings({
    mic: "default",
    volume: "80",
    showIpa: "false",
    autoAdvance: "true",
    liveHighlight: "1",
    stt: "whisper",
    tempo: "0.75",
    whisperModel: "base.en",
    voice: "en-US-JennyNeural",
  });
  assert.equal(parsed.mic, "default");
  assert.equal(parsed.volume, 80);
  assert.equal(parsed.showIpa, false);
  assert.equal(parsed.autoAdvance, true);
  assert.equal(parsed.liveHighlight, true);
  assert.equal(parsed.stt, "whisper");
  assert.equal(parsed.tempo, 0.75);
  assert.equal(parsed.whisperModel, "base.en");
  assert.equal(parsed.voice, "en-US-JennyNeural");
});

test("settings: parseLocalSettings ignores invalid values", () => {
  const parsed = parseLocalSettings({
    volume: "not-a-number",
    showIpa: "maybe",
    stt: "telepathy",
    tempo: "3",
    whisperModel: "large",
  });
  assert.equal(parsed.volume, undefined);
  assert.equal(parsed.showIpa, undefined);
  assert.equal(parsed.stt, undefined);
  assert.equal(parsed.tempo, undefined);
  assert.equal(parsed.whisperModel, undefined);
});

test("settings: parseLocalSettings clamps volume to 0-100", () => {
  assert.equal(parseLocalSettings({ volume: "150" }).volume, 100);
  assert.equal(parseLocalSettings({ volume: "-5" }).volume, 0);
});

// ---------------------------------------------------------------------------
// parseProfileSettings / profileSettings
// ---------------------------------------------------------------------------

test("settings: parseProfileSettings keeps only profile-persisted keys", () => {
  const parsed = parseProfileSettings({
    rigor: "Estricto",
    fillers: "Tolerancia Cero",
    adaptive: { enabled: false, up: 85, down: 60 },
    prepTime: 5,
    provider: "gemini",
    personaName: "Google EM",
    targetLevel: "C1",
    bio: "Backend engineer",
    prompt: "Act as a hiring manager",
    focusPhonemes: ["θ", "ð"],
    volume: 50, // device pref — must be ignored
  });
  assert.equal(parsed.rigor, "Estricto");
  assert.equal(parsed.fillers, "Tolerancia Cero");
  assert.deepEqual(parsed.adaptive, { enabled: false, up: 85, down: 60 });
  assert.equal(parsed.prepTime, 5);
  assert.equal(parsed.provider, "gemini");
  assert.equal(parsed.personaName, "Google EM");
  assert.equal(parsed.targetLevel, "C1");
  assert.equal(parsed.bio, "Backend engineer");
  assert.equal(parsed.prompt, "Act as a hiring manager");
  assert.deepEqual(parsed.focusPhonemes, ["θ", "ð"]);
  assert.equal(parsed.volume, undefined);
});

test("settings: profileSettings reads settings + legacy focusPhonemes", () => {
  const profile: Profile = {
    level: "B2",
    categories: {},
    weakErrors: {},
    vocabGaps: [],
    recentTopics: [],
    focusPhonemes: ["θ"],
    settings: { rigor: "Flexible", prepTime: 0 },
  };
  const parsed = profileSettings(profile);
  assert.equal(parsed.rigor, "Flexible");
  assert.equal(parsed.prepTime, 0);
  assert.deepEqual(parsed.focusPhonemes, ["θ"]);
});

// ---------------------------------------------------------------------------
// readSnapshotSettings
// ---------------------------------------------------------------------------

test("settings: readSnapshotSettings reads the captured overrides", () => {
  const snapshot = {
    version: 1,
    overrides: {
      rigor: "Estricto",
      fillers: "Sensible",
      adaptive: { enabled: true, up: 92, down: 68 },
      prepTime: 5,
      provider: "ollama",
      autoAdvance: true,
      passThreshold: 93,
    },
  };
  const s = readSnapshotSettings(snapshot);
  assert.equal(s.rigor, "Estricto");
  assert.equal(s.fillers, "Sensible");
  assert.deepEqual(s.adaptive, { enabled: true, up: 92, down: 68 });
  assert.equal(s.prepTime, 5);
  assert.equal(s.provider, "ollama");
  assert.equal(s.autoAdvance, true);
});

// ---------------------------------------------------------------------------
// mergeSettings precedence: snapshot > local > profile > defaults
// ---------------------------------------------------------------------------

test("settings: mergeSettings precedence snapshot > local > profile > defaults", () => {
  const merged = mergeSettings({
    snapshot: { version: 1, overrides: { rigor: "Estricto", prepTime: 5, provider: "ollama" } },
    local: { rigor: "Flexible", prepTime: 0, stt: "whisper" },
    profile: { rigor: "Balanceado", fillers: "Sensible", prepTime: 3, provider: "gemini" },
  });
  // snapshot wins on rigor/prepTime/provider
  assert.equal(merged.rigor, "Estricto");
  assert.equal(merged.prepTime, 5);
  assert.equal(merged.provider, "ollama");
  // local wins on stt (snapshot has none)
  assert.equal(merged.stt, "whisper");
  // profile fills the rest
  assert.equal(merged.fillers, "Sensible");
  // defaults fill everything else
  assert.equal(merged.volume, 100);
  assert.equal(merged.whisperModel, "small.en");
});

test("settings: mergeSettings deep-merges adaptive", () => {
  const merged = mergeSettings({
    snapshot: { version: 1, overrides: { adaptive: { enabled: false } } },
    profile: { adaptive: { up: 85, down: 60 } },
  });
  assert.equal(merged.adaptive.enabled, false);
  assert.equal(merged.adaptive.up, 85);
  assert.equal(merged.adaptive.down, 60);
});

// ---------------------------------------------------------------------------
// buildSettingsSnapshot — always writes the 7 training keys
// ---------------------------------------------------------------------------

test("settings: buildSettingsSnapshot writes all training keys", () => {
  const snapshot = buildSettingsSnapshot({
    ...DEFAULT_SETTINGS,
    rigor: "Estricto",
    fillers: "Tolerancia Cero",
    adaptive: { enabled: false, up: 88, down: 55 },
    prepTime: 5,
    provider: "gemini",
    autoAdvance: true,
  });
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.overrides.rigor, "Estricto");
  assert.equal(snapshot.overrides.fillers, "Tolerancia Cero");
  assert.deepEqual(snapshot.overrides.adaptive, { enabled: false, up: 88, down: 55 });
  assert.equal(snapshot.overrides.prepTime, 5);
  assert.equal(snapshot.overrides.provider, "gemini");
  assert.equal(snapshot.overrides.autoAdvance, true);
  assert.equal(snapshot.overrides.passThreshold, RIGOR_THRESHOLDS.Estricto);
});

test("settings: buildSettingsSnapshot derives passThreshold from rigor", () => {
  const flexible = buildSettingsSnapshot({ ...DEFAULT_SETTINGS, rigor: "Flexible" });
  assert.equal(flexible.overrides.passThreshold, 65);
  const balanced = buildSettingsSnapshot({ ...DEFAULT_SETTINGS, rigor: "Balanceado" });
  assert.equal(balanced.overrides.passThreshold, 82);
});

// ---------------------------------------------------------------------------
// readPrepTime / readAutoAdvance
// ---------------------------------------------------------------------------

test("settings: readPrepTime falls back to the default", () => {
  assert.equal(readPrepTime(undefined), 3);
  assert.equal(readPrepTime({ version: 1, overrides: {} }), 3);
  assert.equal(readPrepTime({ version: 1, overrides: { prepTime: 0 } }), 0);
  assert.equal(readPrepTime({ version: 1, overrides: { prepTime: 5 } }), 5);
  assert.equal(readPrepTime({ version: 1, overrides: { prepTime: 99 } }), 3);
});

test("settings: readAutoAdvance falls back to the default", () => {
  assert.equal(readAutoAdvance(undefined), false);
  assert.equal(readAutoAdvance({ version: 1, overrides: {} }), false);
  assert.equal(readAutoAdvance({ version: 1, overrides: { autoAdvance: true } }), true);
});

// ---------------------------------------------------------------------------
// applyProfileSettings — idempotent round-trip
// ---------------------------------------------------------------------------

test("settings: applyProfileSettings persists profile keys and preserves the rest", () => {
  const profile: Profile = {
    level: "B2",
    categories: {},
    weakErrors: {},
    vocabGaps: [],
    recentTopics: [],
    focusPhonemes: ["θ"],
  };
  const updated = applyProfileSettings(profile, {
    rigor: "Estricto",
    prepTime: 5,
    provider: "ollama",
    focusPhonemes: ["θ", "ð"],
  });
  assert.equal(updated.settings?.rigor, "Estricto");
  assert.equal(updated.settings?.prepTime, 5);
  assert.equal(updated.settings?.provider, "ollama");
  assert.deepEqual(updated.focusPhonemes, ["θ", "ð"]);
  assert.equal(updated.level, "B2");
});

test("settings: applyProfileSettings is idempotent (missing fields keep previous)", () => {
  const profile: Profile = {
    level: "B2",
    categories: {},
    weakErrors: {},
    vocabGaps: [],
    recentTopics: [],
    settings: { rigor: "Flexible", prepTime: 0, provider: "gemini" },
  };
  const updated = applyProfileSettings(profile, { prepTime: 5 });
  assert.equal(updated.settings?.rigor, "Flexible");
  assert.equal(updated.settings?.prepTime, 5);
  assert.equal(updated.settings?.provider, "gemini");
});