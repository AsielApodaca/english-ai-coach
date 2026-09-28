/**
 * Settings sub-tab: General & Audio (feature 108, spec §1).
 *
 * Device prefs persisted in localStorage under `engcoach.*`:
 * mic, volume, showIpa, autoAdvance, liveHighlight.
 */

import { h } from "../dom.js";
import { settingsSection, settingRow, toggleControl } from "./ui.js";
import { getLocal, setLocal } from "./local.js";
import { clampVolumePct, MIN_VOLUME_PCT, MAX_VOLUME_PCT } from "./volume.js";

/**
 * Render the General & Audio tab into `root`.
 * @param {HTMLElement} root
 * @param {{ profile: object, health: object|null, storage: object, saveProfileSettings: (patch: object) => void }} ctx
 */
export function renderGeneralAudio(root, ctx) {
  root.innerHTML = "";
  root.appendChild(
    h("div", { class: "settings-panel" }, [
      settingsSection("Audio", [
        settingRow({
          label: "Dispositivo de entrada",
          hint: "Micrófono usado para las repeticiones (push-to-talk).",
          control: micSelect(),
        }),
        settingRow({
          label: "Volumen",
          hint: "Volumen del coach (TTS). Mínimo 10%.",
          control: volumeSlider(),
        }),
      ]),
      settingsSection("Karaoke", [
        settingRow({
          label: "Anotación de pronunciación",
          hint: "Muestra la pronunciación legible bajo la letra (sílabas separadas y tónica en mayúsculas, p. ej. working → WUR·king).",
          control: toggleControl({
            label: "Anotación de pronunciación",
            checked: Boolean(getLocal("showIpa", true)),
            onChange: (v) => setLocal("showIpa", v),
          }),
        }),
        settingRow({
          label: "Avanzar automáticamente",
          hint: "Pasa a la siguiente pregunta sin pulsar nada.",
          control: toggleControl({
            label: "Avanzar automáticamente",
            checked: Boolean(getLocal("autoAdvance", false)),
            onChange: (v) => setLocal("autoAdvance", v),
          }),
        }),
        settingRow({
          label: "Resaltado en vivo",
          hint: "Colorea las palabras verdes/ámbar/rojas al evaluar.",
          control: toggleControl({
            label: "Resaltado en vivo",
            checked: Boolean(getLocal("liveHighlight", true)),
            onChange: (v) => setLocal("liveHighlight", v),
          }),
        }),
      ]),
    ]),
  );
}

/** Mic device select: "Default" + the enumerated audio inputs. */
function micSelect() {
  const select = h(
    "select",
    { class: "settings-select", "aria-label": "Dispositivo de entrada" },
    [h("option", { value: "" }, "Default")],
  );
  select.value = String(getLocal("mic", ""));
  select.addEventListener("change", () => setLocal("mic", select.value));
  navigator.mediaDevices
    ?.enumerateDevices?.()
    .then((devices) => {
      const mics = devices.filter((d) => d.kind === "audioinput");
      for (const d of mics) {
        select.appendChild(h("option", { value: d.deviceId }, d.label || "Micrófono"));
      }
      select.value = String(getLocal("mic", ""));
    })
    .catch(() => {});
  return select;
}

/**
 * Volume slider (10–100) with a live % readout.
 *
 * The floor is `MIN_VOLUME_PCT`: a silent coach defeats the point of the
 * practice session, so the control cannot go below it and a legacy `0` stored
 * by older builds reads back as 10%.
 */
function volumeSlider() {
  const current = clampVolumePct(getLocal("volume", 100));
  const input = h("input", {
    type: "range",
    class: "settings-range",
    min: String(MIN_VOLUME_PCT),
    max: String(MAX_VOLUME_PCT),
    value: String(current),
    "aria-label": "Volumen",
  });
  const valueEl = h("span", { class: "settings-range-value" }, `${current}%`);
  input.addEventListener("input", () => {
    const pct = clampVolumePct(input.value);
    valueEl.textContent = `${pct}%`;
    setLocal("volume", pct);
  });
  return h("div", { class: "settings-range-wrap" }, [input, valueEl]);
}
