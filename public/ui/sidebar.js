/**
 * Session history sidebar (feature 109).
 *
 * Renders the real history from GET /api/sessions?group=recency: sessions
 * grouped Today / Yesterday / Previous 7 Days / Older, each item with a
 * pronunciation-score progress ring (crimson → emerald), a CEFR level badge,
 * the score, and an "ACTIVA (Q{n})" badge for the session in progress.
 * Clicking an item resumes it (#/practice/<id>); each item offers export
 * (JSON download) and delete (confirmed for active sessions — NFR).
 * Also binds the collapse button (brand header), the reopen button (top bar)
 * and the drawer backdrop (tablet/mobile).
 */

import { h, escapeHtml } from "./dom.js";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Create an SVG element (the h() helper only builds HTML elements). */
function svgEl(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    el.setAttribute(key, String(value));
  }
  return el;
}

/** Ring color: crimson (0%) → emerald (100%) via the hue scale. */
function ringColor(score) {
  const hue = ((Math.max(0, Math.min(100, score ?? 0)) / 100) * 160).toFixed(1);
  return `hsl(${hue} 70% 50%)`;
}

/** Build the pronunciation-score progress ring (SVG circle + dash offset). */
function progressRing(score) {
  const r = 15.5;
  const c = 2 * Math.PI * r;
  const svg = svgEl("svg", { class: "progress-ring", viewBox: "0 0 36 36", "aria-hidden": "true" });
  svg.appendChild(svgEl("circle", { class: "ring-bg", cx: "18", cy: "18", r: String(r) }));
  const fg = svgEl("circle", { class: "ring-fg", cx: "18", cy: "18", r: String(r) });
  const value = Math.max(0, Math.min(100, score ?? 0));
  fg.style.strokeDasharray = String(c);
  fg.style.strokeDashoffset = String(c * (1 - value / 100));
  fg.style.stroke = ringColor(score);
  svg.appendChild(fg);
  return svg;
}

/** Build one history item: ring + title/meta + export/delete actions. */
function buildItem(summary, { onOpen, onExport, onDelete }) {
  const active = summary.status === "active";
  const q = Math.max(1, summary.progress.total);
  const meta = [h("span", { class: "level-badge" }, summary.level)];
  if (summary.score != null) meta.push(h("span", { class: "history-item-score" }, `${summary.score}%`));
  if (active) meta.push(h("span", { class: "active-badge" }, `ACTIVA (Q${q})`));

  return h("div", { class: "history-item", dataset: { id: summary.id } }, [
    h(
      "button",
      {
        type: "button",
        class: "history-item-main",
        title: active ? "Reanudar sesión" : "Ver sesión",
        onclick: () => onOpen(summary.id),
      },
      [
        progressRing(summary.score),
        h("span", { class: "history-item-text" }, [
          h("span", { class: "history-item-title" }, escapeHtml(summary.title || "Untitled session")),
          h("span", { class: "history-item-meta" }, meta),
        ]),
      ],
    ),
    h("div", { class: "history-item-actions" }, [
      h(
        "button",
        {
          type: "button",
          class: "icon-btn history-item-action",
          title: "Exportar sesión (JSON)",
          "aria-label": `Exportar ${summary.title}`,
          onclick: () => onExport(summary.id),
        },
        [h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "download")],
      ),
      h(
        "button",
        {
          type: "button",
          class: "icon-btn history-item-action danger",
          title: "Eliminar sesión",
          "aria-label": `Eliminar ${summary.title}`,
          onclick: () => onDelete(summary.id, summary),
        },
        [h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "delete")],
      ),
    ]),
  ]);
}

/**
 * Initialize the sidebar.
 *
 * @param {import("./store.js").ShellState} store - shell store singleton
 * @param {HTMLElement} root - the `#sidebar` element
 * @param {{ navigate: (path: string) => void }} router - shell router
 * @returns {() => void} unsubscribe
 */
export function initSidebar(store, root, { navigate }) {
  const slots = root.querySelector("#history-slots");
  const itemsById = new Map();

  const toggleBtn = document.getElementById("btn-sidebar-toggle");
  const closeBtn = document.getElementById("btn-sidebar-close");
  const backdrop = document.getElementById("sidebar-backdrop");

  toggleBtn?.addEventListener("click", () => {
    store.set({ sidebarOpen: !store.state.sidebarOpen });
  });
  closeBtn?.addEventListener("click", () => store.set({ sidebarOpen: false }));
  backdrop?.addEventListener("click", () => store.set({ sidebarOpen: false }));

  /** Fetch the grouped history and render it. */
  async function refresh() {
    let groups = [];
    try {
      const res = await fetch("/api/sessions?group=recency");
      if (res.ok) {
        const json = await res.json();
        groups = Array.isArray(json.groups) ? json.groups : [];
      }
    } catch {
      // offline: keep the previous render (or the empty state)
    }
    render(groups);
  }

  /** Render the history groups (or the first-use empty state). */
  function render(groups) {
    slots.innerHTML = "";
    itemsById.clear();
    const hasSessions = groups.some((g) => g.items.length > 0);
    if (!hasSessions) {
      slots.appendChild(
        h("div", { class: "history-empty" }, [
          h("span", { class: "material-symbols-outlined", "aria-hidden": "true" }, "history"),
          h("span", { class: "history-empty-text" }, "No sessions yet"),
        ]),
      );
      return;
    }
    for (const group of groups) {
      const groupEl = h("div", { class: "history-group", dataset: { group: group.label } }, [
        h("div", { class: "history-group-label" }, group.label),
        h("div", { class: "history-group-slots" }),
      ]);
      const groupSlots = groupEl.querySelector(".history-group-slots");
      for (const summary of group.items) {
        const item = buildItem(summary, {
          onOpen: (id) => navigate(`#/practice/${encodeURIComponent(id)}`),
          onExport: (id) => exportSession(id),
          onDelete: (id, s) => deleteSession(id, s),
        });
        itemsById.set(summary.id, item);
        groupSlots.appendChild(item);
      }
      slots.appendChild(groupEl);
    }
  }

  /** Download the full session JSON (low-profile export, feature 109). */
  async function exportSession(id) {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}/export`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const blob = new Blob([JSON.stringify(json, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `session-${id}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // best-effort export
    }
  }

  /** Delete a session; active sessions require confirmation (NFR). */
  async function deleteSession(id, summary) {
    if (summary.status === "active") {
      const ok = window.confirm(
        `La sesión "${summary.title}" está activa. ¿Eliminarla? Esta acción no se puede deshacer.`,
      );
      if (!ok) return;
    }
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!res.ok) return;
      refresh();
    } catch {
      // best-effort delete
    }
  }

  /** Apply the sidebar open/close state + live ACTIVE badge question count. */
  const apply = (s) => {
    document.body.classList.toggle("sidebar-open", s.sidebarOpen);
    if (s.activeQuestion != null && s.activeQuestion > 0 && s.sessionId) {
      const badge = itemsById.get(s.sessionId)?.querySelector(".active-badge");
      if (badge) badge.textContent = `ACTIVA (Q${s.activeQuestion})`;
    }
  };
  apply(store.state);

  // Refresh the history whenever the route changes (resume / finish / delete).
  let lastRoute = store.state.route;
  const unsubs = [
    store.subscribe((state) => {
      apply(state);
      if (state.route !== lastRoute) {
        lastRoute = state.route;
        refresh();
      }
    }),
  ];

  refresh();
  return () => unsubs.forEach((fn) => fn());
}