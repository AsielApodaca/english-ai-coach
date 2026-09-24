/**
 * Settings overlay (feature 108) — 4 sub-tabs.
 *
 * Layout: left nav (General & Audio / Entrenamiento / Modelo IA / Perfil &
 * Datos) + right content pane. Each tab is a partial ES module in
 * `public/ui/settings/` that renders into the content pane with the shared
 * context { profile, health, storage, saveProfileSettings }.
 *
 * The overlay opens and closes without touching the stage, so an active
 * practice keeps its state (spec 108).
 */

import { h } from "./dom.js";
import { renderGeneralAudio } from "./settings/general-audio.js";
import { renderTraining } from "./settings/training.js";
import { renderModelAi } from "./settings/model-ai.js";
import { renderProfileData } from "./settings/profile-data.js";

const TABS = [
  { key: "general", label: "General & Audio", icon: "tune", render: renderGeneralAudio },
  { key: "training", label: "Entrenamiento", icon: "fitness_center", render: renderTraining },
  { key: "model", label: "Modelo & IA", icon: "memory", render: renderModelAi },
  { key: "profile", label: "Perfil & Datos", icon: "person", render: renderProfileData },
];

/**
 * Initialize the settings overlay.
 *
 * @param {HTMLElement} root - the `#settings-overlay` element
 * @returns {{
 *   open: () => void,
 *   close: () => void,
 *   setOnClose: (fn: () => void) => void,
 * }}
 */
export function initSettingsOverlay(root) {
  const closeBtn = root.querySelector("#btn-settings-close");
  const navEl = root.querySelector("#settings-nav");
  const contentEl = root.querySelector("#settings-content");
  const statusEl = root.querySelector("#settings-status");
  let onClose = null;
  let loaded = false;
  let activeTab = "general";
  let ctx = null;

  function open() {
    root.hidden = false;
    document.body.classList.add("overlay-open");
    if (!loaded) {
      loaded = true;
      loadContext();
    }
  }

  function close() {
    root.hidden = true;
    document.body.classList.remove("overlay-open");
  }

  /** Fetch profile + health + storage once, then render the active tab. */
  async function loadContext() {
    statusEl.textContent = "Cargando…";
    const [profileRes, healthRes, storageRes] = await Promise.all([
      fetch("/api/profile").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/health").then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/storage").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    ctx = {
      profile: profileRes?.profile ?? {},
      health: healthRes,
      storage: storageRes ?? {},
      saveProfileSettings: async (patch) => {
        try {
          const res = await fetch("/api/profile/settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          });
          if (res.ok) {
            const json = await res.json();
            ctx.profile = json.profile ?? ctx.profile;
            statusEl.textContent = "Guardado ✓";
          } else {
            statusEl.textContent = "Error al guardar";
          }
        } catch {
          statusEl.textContent = "Error al guardar";
        }
        setTimeout(() => {
          statusEl.textContent = "";
        }, 2000);
      },
    };
    statusEl.textContent = "";
    renderNav();
    renderTab(activeTab);
  }

  /** Build the left nav (one button per tab). */
  function renderNav() {
    navEl.innerHTML = "";
    for (const tab of TABS) {
      const btn = h(
        "button",
        {
          type: "button",
          class: "settings-tab",
          dataset: { tab: tab.key },
          ...(tab.key === activeTab ? { "aria-selected": "true" } : {}),
        },
        [
          h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, tab.icon),
          h("span", { class: "settings-tab-label" }, tab.label),
        ],
      );
      if (tab.key === activeTab) btn.classList.add("active");
      btn.addEventListener("click", () => {
        activeTab = tab.key;
        renderNav();
        renderTab(activeTab);
      });
      navEl.appendChild(btn);
    }
  }

  /** Render the active tab partial into the content pane. */
  function renderTab(key) {
    const tab = TABS.find((t) => t.key === key);
    contentEl.innerHTML = "";
    if (!tab) return;
    tab.render(contentEl, ctx);
  }

  closeBtn.addEventListener("click", () => onClose?.());
  root.addEventListener("click", (e) => {
    if (e.target === root) onClose?.();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !root.hidden) onClose?.();
  });

  return {
    open,
    close,
    setOnClose(fn) {
      onClose = fn;
    },
  };
}