/**
 * Settings sub-tab: Modelo IA (feature 108, spec §3).
 *
 * Provider persists in `profile.json`; whisper model + voice are device
 * prefs (localStorage). The engine map reflects `/api/health` (whisper /
 * piper / edge / LLM providers — the real stack names, spec §5 note).
 */

import { h, escapeHtml } from "../dom.js";
import { settingsSection, settingRow, selectControl } from "./ui.js";
import { getLocal, setLocal } from "./local.js";

const PROVIDER_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "gemini", label: "Gemini" },
  { value: "cloudflare", label: "Cloudflare" },
  { value: "ollama", label: "Ollama (local)" },
];

const WHISPER_MODELS = ["tiny.en", "base.en", "small.en", "medium.en", "tiny", "base", "small", "medium"];

/**
 * Render the Modelo IA tab into `root`.
 * @param {HTMLElement} root
 * @param {{ profile: object, health: object|null, storage: object, saveProfileSettings: (patch: object) => void }} ctx
 */
export function renderModelAi(root, ctx) {
  const settings = ctx.profile?.settings ?? {};
  root.innerHTML = "";
  root.appendChild(
    h("div", { class: "settings-panel" }, [
      settingsSection("Proveedor", [
        settingRow({
          label: "Proveedor LLM primario",
          hint: "Se usa al crear la sesión; fallback automático si falla.",
          control: selectControl({
            label: "Proveedor LLM primario",
            value: settings.provider ?? "auto",
            options: PROVIDER_OPTIONS,
            onChange: (v) => ctx.saveProfileSettings({ provider: v }),
          }),
        }),
      ]),
      settingsSection("Modelos", [
        settingRow({
          label: "Modelo whisper",
          hint: "Modelo STT local (whisper.cpp).",
          control: selectControl({
            label: "Modelo whisper",
            value: getLocal("whisperModel", "small.en"),
            options: WHISPER_MODELS.map((m) => ({ value: m, label: m })),
            onChange: (v) => setLocal("whisperModel", v),
          }),
        }),
        settingRow({
          label: "Voz del coach",
          hint: "Voz TTS (auto = la mejor disponible).",
          control: selectControl({
            label: "Voz del coach",
            value: getLocal("voice", "auto"),
            options: [{ value: "auto", label: "Auto" }],
            onChange: (v) => setLocal("voice", v),
          }),
        }),
      ]),
      settingsSection("Estado de motores", engineRows(ctx.health)),
    ]),
  );
}

/** Build the engine status list from a health payload (or offline state). */
function engineRows(health) {
  const list = h("div", { class: "engine-status-list" });
  if (!health) {
    list.appendChild(engineRow("Server", "offline", "bad"));
    return list;
  }
  const ttsEngine = health.tts?.engine ?? null;
  list.appendChild(engineRow("Speech Engine", ttsEngine ?? "browser fallback", ttsEngine ? "ok" : "warn"));
  const whisper = health.whisper;
  const whisperState = whisper?.available ? (whisper.modelReady ? "ready" : "model pending") : "not installed";
  list.appendChild(engineRow("Whisper (STT)", whisperState, whisper?.available ? "ok" : "warn"));
  const providers = Object.entries(health.providers ?? {});
  const online = providers.filter(([, ok]) => ok).length;
  list.appendChild(engineRow("LLM providers", `${online}/${providers.length} online`, "ok"));
  return list;
}

function engineRow(name, state, tone) {
  return h("div", { class: "engine-row" }, [
    h("span", { class: "engine-name" }, name),
    h("span", { class: `engine-state ${tone}` }, escapeHtml(state)),
  ]);
}