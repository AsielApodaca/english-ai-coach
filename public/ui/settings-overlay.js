/**
 * Settings overlay.
 *
 * Feature 108 owns the real settings UI; in 101 this shows a placeholder plus
 * the live engine status (Speech Engine / Whisper / LLM providers) fetched
 * from `/api/health`. The overlay opens and closes without touching the stage,
 * so an active practice keeps its state.
 */

import { h, escapeHtml } from "./dom.js";

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
  const engineStatusEl = root.querySelector("#engine-status");
  let onClose = null;
  let loaded = false;

  function open() {
    root.hidden = false;
    document.body.classList.add("overlay-open");
    if (!loaded) {
      loaded = true;
      loadEngineStatus();
    }
  }

  function close() {
    root.hidden = true;
    document.body.classList.remove("overlay-open");
  }

  /** Fetch `/api/health` once and render the engine status rows. */
  async function loadEngineStatus() {
    engineStatusEl.innerHTML = "";
    let health = null;
    try {
      const res = await fetch("/api/health");
      if (res.ok) health = await res.json();
    } catch {
      health = null;
    }
    engineStatusEl.appendChild(renderEngineStatus(health));
  }

  /** Build the engine status list from a health payload (or offline state). */
  function renderEngineStatus(health) {
    const list = h("div", { class: "engine-status-list" });

    if (!health) {
      list.appendChild(
        h("div", { class: "engine-row" }, [
          h("span", { class: "engine-name" }, "Server"),
          h("span", { class: "engine-state bad" }, "offline"),
        ]),
      );
      return list;
    }

    const ttsEngine = health.tts?.engine ?? null;
    list.appendChild(
      h("div", { class: "engine-row" }, [
        h("span", { class: "engine-name" }, "Speech Engine"),
        h("span", { class: `engine-state ${ttsEngine ? "ok" : "warn"}` }, escapeHtml(ttsEngine ?? "browser fallback")),
      ]),
    );

    const whisper = health.whisper;
    const whisperState = whisper?.available ? (whisper.modelReady ? "ready" : "model pending") : "not installed";
    list.appendChild(
      h("div", { class: "engine-row" }, [
        h("span", { class: "engine-name" }, "Whisper (STT)"),
        h("span", { class: `engine-state ${whisper?.available ? "ok" : "warn"}` }, whisperState),
      ]),
    );

    const providers = Object.entries(health.providers ?? {});
    const online = providers.filter(([, ok]) => ok).length;
    list.appendChild(
      h("div", { class: "engine-row" }, [
        h("span", { class: "engine-name" }, "LLM providers"),
        h("span", { class: "engine-state ok" }, `${online}/${providers.length} online`),
      ]),
    );

    return list;
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