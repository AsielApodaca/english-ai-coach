/**
 * Settings sub-tab: Entrenamiento & Pronunciación (feature 108, spec §2).
 *
 * STT engine + tempo are device prefs (localStorage `engcoach.*`); rigor,
 * fillers and adaptive persist in `profile.json` via
 * `saveProfileSettings` and feed the session snapshot at creation time.
 */

import { h } from "../dom.js";
import { settingsSection, settingRow, toggleControl, segmentedControl, selectControl, numberControl } from "./ui.js";
import { getLocal, setLocal } from "./local.js";

const RIGOR_OPTIONS = [
  { value: "Flexible", label: "Flexible" },
  { value: "Balanceado", label: "Balanceado" },
  { value: "Estricto", label: "Estricto" },
];

const FILLER_OPTIONS = [
  { value: "Relajado", label: "Relajado" },
  { value: "Moderado", label: "Moderado" },
  { value: "Sensible", label: "Sensible" },
  { value: "Tolerancia Cero", label: "Tolerancia Cero" },
];

const TEMPO_OPTIONS = [
  { value: 0.75, label: "0.75×" },
  { value: 1, label: "1×" },
  { value: 1.25, label: "1.25×" },
];

/**
 * Render the Entrenamiento tab into `root`.
 * @param {HTMLElement} root
 * @param {{ profile: object, health: object|null, storage: object, saveProfileSettings: (patch: object) => void }} ctx
 */
export function renderTraining(root, ctx) {
  const settings = ctx.profile?.settings ?? {};
  root.innerHTML = "";
  root.appendChild(
    h("div", { class: "settings-panel" }, [
      settingsSection("Reconocimiento", [
        settingRow({
          label: "Motor de reconocimiento",
          hint: "Whisper local o Web Speech del navegador.",
          control: selectControl({
            label: "Motor de reconocimiento",
            value: getLocal("stt", "auto"),
            options: [
              { value: "auto", label: "Auto" },
              { value: "whisper", label: "Whisper (local)" },
              { value: "browser", label: "Web Speech" },
            ],
            onChange: (v) => setLocal("stt", v),
          }),
        }),
        settingRow({
          label: "Ritmo de práctica",
          hint: "Velocidad del coach (TTS).",
          control: segmentedControl({
            label: "Ritmo de práctica",
            value: getLocal("tempo", 1),
            options: TEMPO_OPTIONS,
            onChange: (v) => setLocal("tempo", Number(v)),
          }),
        }),
      ]),
      settingsSection("Entrenamiento", [
        settingRow({
          label: "Rigor",
          hint: "Umbral F1: Flexible >65 · Balanceado >82 · Estricto >93.",
          control: segmentedControl({
            label: "Rigor",
            value: settings.rigor ?? "Balanceado",
            options: RIGOR_OPTIONS,
            onChange: (v) => ctx.saveProfileSettings({ rigor: v }),
          }),
        }),
        settingRow({
          label: "Sensibilidad a muletillas",
          hint: "Tolerancia a fillers (um, eh, like…).",
          control: segmentedControl({
            label: "Sensibilidad a muletillas",
            value: settings.fillers ?? "Moderado",
            options: FILLER_OPTIONS,
            onChange: (v) => ctx.saveProfileSettings({ fillers: v }),
          }),
        }),
        settingRow({
          label: "Flujo continuo adaptativo",
          hint: "Ajusta nivel/rigor según el promedio de las últimas 3 respuestas.",
          control: toggleControl({
            label: "Flujo continuo adaptativo",
            checked: settings.adaptive?.enabled ?? true,
            onChange: (v) =>
              ctx.saveProfileSettings({ adaptive: { ...(settings.adaptive ?? {}), enabled: v } }),
          }),
        }),
        settingRow({
          label: "Subir con promedio ≥",
          hint: "Umbral para subir un escalón de dificultad.",
          control: numberControl({
            label: "Subir con promedio ≥",
            value: settings.adaptive?.up ?? 90,
            min: 0,
            max: 100,
            onChange: (v) =>
              ctx.saveProfileSettings({ adaptive: { ...(settings.adaptive ?? {}), up: v } }),
          }),
        }),
        settingRow({
          label: "Bajar con promedio <",
          hint: "Umbral para bajar un escalón de dificultad.",
          control: numberControl({
            label: "Bajar con promedio <",
            value: settings.adaptive?.down ?? 65,
            min: 0,
            max: 100,
            onChange: (v) =>
              ctx.saveProfileSettings({ adaptive: { ...(settings.adaptive ?? {}), down: v } }),
          }),
        }),
      ]),
    ]),
  );
}