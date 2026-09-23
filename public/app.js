/**
 * Shell bootstrap for the cockpit layout (feature 101).
 *
 * Wires the singleton store, hash router, dock, sidebar and settings overlay,
 * and keeps the top-bar "Speech Engine" pill in sync with `/api/health`.
 * The old tab-based fabric (practice / free chat / progress / settings) is
 * gone; the stage zones are placeholders owned by features 103/105/109/108.
 */

import { createShellStore } from "./ui/store.js";
import { initRouter } from "./ui/router.js";
import { initDock } from "./ui/dock.js";
import { initSidebar } from "./ui/sidebar.js";
import { initSettingsOverlay } from "./ui/settings-overlay.js";

const store = createShellStore();

// ---------- top bar ----------
const speechPill = document.getElementById("speech-pill");
const speechPillState = document.getElementById("speech-pill-state");
const btnNewSession = document.getElementById("btn-new-session");
const btnSettings = document.getElementById("btn-settings");

/** Fetch `/api/health` and reflect the speech engine state in the pill. */
async function loadHealth() {
  speechPillState.textContent = "…";
  try {
    const res = await fetch("/api/health");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const health = await res.json();
    const engine = health.tts?.engine;
    const ready = engine === "piper" || engine === "edge-tts";
    store.set({ speechReady: ready });
    speechPillState.textContent = ready ? "READY" : "BROWSER";
    speechPill.classList.toggle("ok", ready);
    speechPill.classList.toggle("bad", !ready);
  } catch {
    speechPillState.textContent = "OFFLINE";
    speechPill.classList.remove("ok");
    speechPill.classList.add("bad");
  }
}

// ---------- sidebar initial state (open on desktop, drawer on smaller) ----------
const desktop = window.matchMedia("(min-width: 1025px)");
store.set({ sidebarOpen: desktop.matches });
desktop.addEventListener("change", (e) => store.set({ sidebarOpen: e.matches }));

// ---------- modules ----------
initSidebar(store, document.getElementById("sidebar"));
const settingsOverlay = initSettingsOverlay(document.getElementById("settings-overlay"));
const router = initRouter(store, {
  stage: document.getElementById("stage"),
  configView: document.getElementById("view-config"),
  practiceView: document.getElementById("view-practice"),
  settingsOverlay,
});
initDock(store, document.getElementById("dock"));

// ---------- global actions ----------
btnNewSession.addEventListener("click", () => router.navigate("#/"));
btnSettings.addEventListener("click", () => router.openSettings());

// ⌘K (or Ctrl+K) → new session (back to config).
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    router.navigate("#/");
  }
});

loadHealth();