/**
 * Hash router for the SPA shell.
 *
 * Routes:
 *   #/                  → { view: "config" }
 *   #/practice/<id>     → { view: "practice", sessionId: <id> }
 *   #/settings          → settings overlay (opened on top of the current view)
 *   anything else       → redirect to #/
 *
 * The router rehydrates the stage by toggling the config/practice views and
 * mirroring the route into the shell store. Settings is an overlay, so the
 * underlying view keeps its state while it is open.
 */

/**
 * Parse a location hash into a route descriptor.
 * @param {string} hash
 * @returns {{ view: string, sessionId?: string|null, redirect?: boolean }}
 */
export function parseHash(hash) {
  const path = hash.replace(/^#\/?/, "").replace(/\/+$/, "");
  if (path === "") return { view: "config" };
  if (path === "settings") return { view: "settings" };
  const match = path.match(/^practice\/(.+)$/);
  if (match) return { view: "practice", sessionId: match[1] };
  return { view: "config", redirect: true };
}

/**
 * Initialize the router.
 *
 * @param {import("./store.js").ShellState} store - shell store singleton
 * @param {{
 *   stage: HTMLElement,
 *   configView: HTMLElement,
 *   practiceView: HTMLElement,
 *   settingsOverlay: { open: () => void, close: () => void, setOnClose: (fn: () => void) => void },
 * }} elements
 * @returns {{ navigate: (path: string) => void, openSettings: () => void }}
 */
export function initRouter(store, elements) {
  const { stage, configView, practiceView, settingsOverlay } = elements;
  const crumbCurrent = document.getElementById("crumb-current");
  const CRUMB_LABEL = { config: "Config", practice: "Practice" };
  let returnHash = null;

  /** Render the current hash into the stage and store. */
  function render() {
    const route = parseHash(location.hash);

    if (route.redirect && location.hash !== "#/") {
      location.replace("#/");
      return;
    }

    if (route.view === "settings") {
      settingsOverlay.open();
      return;
    }

    settingsOverlay.close();
    store.set({ route, sessionId: route.sessionId ?? null });

    const showConfig = route.view === "config";
    configView.hidden = !showConfig;
    practiceView.hidden = showConfig;
    stage.dataset.view = route.view;
    if (crumbCurrent) crumbCurrent.textContent = CRUMB_LABEL[route.view] ?? "Config";
  }

  /** Navigate to a hash path, re-rendering immediately if already there. */
  function navigate(path) {
    if (location.hash === path) {
      render();
    } else {
      location.hash = path;
    }
  }

  /** Open the settings overlay, remembering where to return on close. */
  function openSettings() {
    returnHash = location.hash || "#/";
    navigate("#/settings");
  }

  settingsOverlay.setOnClose(() => navigate(returnHash && returnHash !== "#/settings" ? returnHash : "#/"));

  window.addEventListener("hashchange", render);
  render();

  return { navigate, openSettings };
}