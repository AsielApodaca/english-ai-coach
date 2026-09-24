/**
 * Settings sub-tab: Perfil & Datos (feature 108, spec §4).
 *
 * Persona + prompt + focus phonemes persist in `profile.json`; the storage
 * report comes from `/api/storage` and the export button downloads
 * `/api/export` as a JSON file.
 */

import { h } from "../dom.js";
import { settingsSection, settingRow, textControl, textareaControl, selectControl } from "./ui.js";

const LEVEL_OPTIONS = ["A1", "A2", "B1", "B2", "C1", "C2"];

const PHONEME_OPTIONS = ["/θ/", "/ð/", "/v/", "/b/", "/æ/", "/ɪ/", "/iː/", "/r/", "/h/"];

/**
 * Render the Perfil & Datos tab into `root`.
 * @param {HTMLElement} root
 * @param {{ profile: object, health: object|null, storage: object, saveProfileSettings: (patch: object) => void }} ctx
 */
export function renderProfileData(root, ctx) {
  const profile = ctx.profile ?? {};
  const settings = profile.settings ?? {};
  const storage = ctx.storage ?? {};
  root.innerHTML = "";
  root.appendChild(
    h("div", { class: "settings-panel" }, [
      settingsSection("Persona del aprendiz", [
        settingRow({
          label: "Nombre",
          control: textControl({
            label: "Nombre",
            value: settings.personaName ?? "",
            placeholder: "Tu nombre",
            onChange: (v) => ctx.saveProfileSettings({ personaName: v }),
          }),
        }),
        settingRow({
          label: "Nivel objetivo",
          control: selectControl({
            label: "Nivel objetivo",
            value: settings.targetLevel ?? "B2",
            options: LEVEL_OPTIONS.map((l) => ({ value: l, label: l })),
            onChange: (v) => ctx.saveProfileSettings({ targetLevel: v }),
          }),
        }),
        settingRow({
          label: "Bio",
          hint: "Contexto breve para el coach.",
          control: textControl({
            label: "Bio",
            value: settings.bio ?? "",
            placeholder: "Ingeniero backend, 5 años…",
            onChange: (v) => ctx.saveProfileSettings({ bio: v }),
          }),
        }),
      ]),
      settingsSection("Prompt del aprendiz", [
        settingRow({
          label: "System persona",
          hint: "Instrucción editable que recibe el LLM.",
          control: textareaControl({
            label: "System persona",
            value: settings.prompt ?? "",
            placeholder: "Simula ser un Engineering Manager…",
            onChange: (v) => ctx.saveProfileSettings({ prompt: v }),
          }),
        }),
      ]),
      settingsSection("Focus fonéticos", [
        settingRow({
          label: "Fonemas",
          hint: "Confusiones hispanas a vigilar.",
          control: phonemeChips(profile.focusPhonemes ?? [], ctx),
        }),
      ]),
      settingsSection("Datos", [
        settingRow({
          label: "Storage",
          hint: `${storage.dataDir ?? "data/"} · ${formatBytes(storage.totalBytes ?? 0)} en ${storage.sessionsCount ?? 0} sesiones`,
          control: h("span", { class: "settings-readonly" }, `${formatBytes(storage.profileBytes ?? 0)} perfil`),
        }),
        settingRow({
          label: "Export JSON",
          hint: "Descarga perfil + sesiones.",
          control: h("button", { type: "button", class: "btn ghost", onclick: exportJson }, [
            h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "download"),
            "Exportar",
          ]),
        }),
      ]),
    ]),
  );
}

/** Multi-select phoneme chips (toggleable, persisted to the profile). */
function phonemeChips(selected, ctx) {
  const wrap = h("div", { class: "phoneme-chips" });
  for (const p of PHONEME_OPTIONS) {
    const chip = h(
      "button",
      {
        type: "button",
        class: "phoneme-chip",
        ...(selected.includes(p) ? { "aria-pressed": "true" } : {}),
      },
      p,
    );
    if (selected.includes(p)) chip.classList.add("active");
    chip.addEventListener("click", () => {
      const next = selected.includes(p) ? selected.filter((x) => x !== p) : [...selected, p];
      chip.classList.toggle("active", next.includes(p));
      chip.setAttribute("aria-pressed", String(next.includes(p)));
      ctx.saveProfileSettings({ focusPhonemes: next });
    });
    wrap.appendChild(chip);
  }
  return wrap;
}

/** Download the full local data export as a JSON file (best-effort). */
async function exportJson() {
  try {
    const res = await fetch("/api/export");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `english-ai-coach-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    // silent: the export button is best-effort
  }
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}