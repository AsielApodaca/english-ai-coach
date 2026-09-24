/**
 * Session history sidebar.
 *
 * Feature 109 owns the real history data; in 101 this renders the
 * Today / Yesterday / Previous 7 Days groups as empty placeholder slots.
 * It also binds the collapse button (brand header, desktop), the reopen
 * button (top bar) and the drawer backdrop (tablet/mobile).
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

  // Active-session slot (feature 107): "ACTIVA (Q{n})" while a continuous
  // session is running; hidden otherwise.
  const activeSlot = h("div", { class: "history-slot active-session", hidden: true }, [
    h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "graphic_eq"),
    h("span", { class: "history-slot-text" }, "ACTIVA"),
  ]);
  slots.appendChild(activeSlot);

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
  const closeBtn = document.getElementById("btn-sidebar-close");
  const backdrop = document.getElementById("sidebar-backdrop");

  toggleBtn?.addEventListener("click", () => {
    store.set({ sidebarOpen: !store.state.sidebarOpen });
  });
  closeBtn?.addEventListener("click", () => store.set({ sidebarOpen: false }));
  backdrop?.addEventListener("click", () => store.set({ sidebarOpen: false }));

  const apply = (s) => {
    document.body.classList.toggle("sidebar-open", s.sidebarOpen);
    const q = s.activeQuestion;
    if (q != null && q > 0) {
      activeSlot.hidden = false;
      activeSlot.querySelector(".history-slot-text").textContent = `ACTIVA (Q${q})`;
    } else {
      activeSlot.hidden = true;
    }
  };
  apply(store.state);
  return store.subscribe(apply);
}