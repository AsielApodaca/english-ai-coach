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
          hint: "Voz TTS (auto = la mejor disponible). Solo voces ya descargadas.",
          control: selectControl({
            label: "Voz del coach",
            value: getLocal("voice", "auto"),
            options: voiceOptions(ctx.health),
            onChange: (v) => setLocal("voice", v),
          }),
        }),
      ]),
      settingsSection("Estado de motores", engineRows(ctx.health)),
    ]),
  );
}

/**
 * Options of the "Voz del coach" select (feature 114): Auto plus every Piper
 * voice ALREADY DOWNLOADED (`readyVoices` from `/api/health`) so choosing one
 * can never send an unsupported id to `/api/tts`. Outside the Piper engine
 * (edge/browser) only Auto is meaningful — the chain decides the voice.
 *
 * @param {object|null} health - the /api/health payload
 * @returns {{value: string, label: string}[]}
 */
function voiceOptions(health) {
  const opts = [{ value: "auto", label: "Auto" }];
  if (health?.tts?.engine !== "piper") return opts;
  const ready = health.tts.piper?.readyVoices ?? [];
  for (const v of ready) opts.push({ value: v, label: v });
  return opts;
}

/** Build the engine status list from a health payload (or offline state). */
function engineRows(health) {
  const list = h("div", { class: "engine-status-list" });
  if (!health) {
    list.appendChild(engineRow("Server", "offline", "bad"));
    return list;
  }
  const ttsEngine = health.tts?.engine ?? null;
  // Feature 114: make the degradation VISIBLE — "browser" is the mechanical
  // fallback, and the hint names the command that installs Piper/edge.
  const ttsState = ttsEngine ?? `browser (${health.tts?.piper?.hint ?? "npm run setup -- --tts"})`;
  list.appendChild(engineRow("Speech Engine", ttsState, ttsEngine ? "ok" : "warn"));
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