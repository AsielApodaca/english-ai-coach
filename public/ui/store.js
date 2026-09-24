/**
 * Global shell state singleton.
 *
 * Components read the current state via `store.state` and subscribe with
 * `store.subscribe(fn)`. Mutations go through `store.set(patch)`, which
 * shallow-merges the patch and notifies every subscriber.
 */

/**
 * @typedef {Object} ShellState
 * @property {{ view: string, sessionId?: string|null }} route
 * @property {string|null} sessionId
 * @property {boolean} speechReady
 * @property {boolean} sidebarOpen
 * @property {number|null} activeQuestion - question count of the active session (feature 107)
 */

/**
 * Create the shell store singleton.
 * @returns {{
 *   state: ShellState,
 *   set: (patch: Partial<ShellState>) => void,
 *   subscribe: (fn: (state: ShellState) => void) => () => void,
 * }}
 */
export function createShellStore() {
  const state = {
    route: { view: "config" },
    sessionId: null,
    speechReady: false,
    sidebarOpen: true,
    activeQuestion: null,
  };
  const listeners = new Set();

  /** Merge a patch into the state and notify all subscribers. */
  function set(patch) {
    Object.assign(state, patch);
    for (const fn of listeners) fn(state);
  }

  /** Register a subscriber; returns an unsubscribe function. */
  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { state, set, subscribe };
}