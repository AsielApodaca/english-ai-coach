/**
 * Session history sidebar.
 *
 * Feature 109 owns the real history data; in 101 this renders the
 * Today / Yesterday / Previous 7 Days groups as empty placeholder slots.
 * It also binds the sidebar toggle (top bar) and the drawer backdrop.
 */

import { h } from "./dom.js";

const GROUPS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "prev7", label: "Previous 7 Days" },
];

/**
 * Initialize the sidebar.
 *
 * @param {import("./store.js").ShellState} store - shell store singleton
 * @param {HTMLElement} root - the `#sidebar` element
 * @returns {() => void} unsubscribe
 */
export function initSidebar(store, root) {
  const slots = root.querySelector("#history-slots");
  slots.innerHTML = "";
  for (const group of GROUPS) {
    slots.appendChild(
      h("div", { class: "history-group", dataset: { group: group.key } }, [
        h("div", { class: "history-group-label" }, group.label),
        h("div", { class: "history-group-slots" }, [
          h("div", { class: "history-slot empty" }, [
            h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "history"),
            h("span", { class: "history-slot-text" }, "No sessions yet"),
          ]),
        ]),
      ]),
    );
  }

  const toggleBtn = document.getElementById("btn-sidebar-toggle");
  const backdrop = document.getElementById("sidebar-backdrop");

  toggleBtn?.addEventListener("click", () => {
    store.set({ sidebarOpen: !store.state.sidebarOpen });
  });
  backdrop?.addEventListener("click", () => store.set({ sidebarOpen: false }));

  const apply = (s) => document.body.classList.toggle("sidebar-open", s.sidebarOpen);
  apply(store.state);
  return store.subscribe(apply);
}