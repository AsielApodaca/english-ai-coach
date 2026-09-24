/**
 * Device preferences (feature 108) — localStorage under the `engcoach.*`
 * prefix.
 *
 * These are the per-device settings (mic, volume, showIpa, autoAdvance,
 * liveHighlight, stt, tempo, whisperModel, voice). Training and persona
 * settings live in `profile.json` and never touch localStorage.
 *
 * Every mutation dispatches a `engcoach:settings-changed` CustomEvent so the
 * practice view can react live (IPA toggle, auto-advance, live highlight)
 * without a reload (spec 108).
 */

const PREFIX = "engcoach.";

/**
 * Read a device pref; returns `fallback` when missing or unparseable.
 * @param {string} key
 * @param {unknown} [fallback]
 * @returns {unknown}
 */
export function getLocal(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** Write a device pref and notify subscribers. */
export function setLocal(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // storage full / private mode — ignore
  }
  notifySettingsChanged();
}

/** Remove a device pref and notify subscribers. */
export function resetLocal(key) {
  localStorage.removeItem(PREFIX + key);
  notifySettingsChanged();
}

/** All device prefs as a plain object (keys without the prefix). */
export function allLocalSettings() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !key.startsWith(PREFIX)) continue;
    const name = key.slice(PREFIX.length);
    try {
      out[name] = JSON.parse(localStorage.getItem(key));
    } catch {
      out[name] = localStorage.getItem(key);
    }
  }
  return out;
}

/** Dispatch the settings-changed event (also used by reset). */
export function notifySettingsChanged() {
  window.dispatchEvent(new CustomEvent("engcoach:settings-changed"));
}