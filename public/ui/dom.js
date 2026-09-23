/**
 * Minimal DOM helpers for building the shell UI without a framework.
 */

/**
 * Create a DOM element from a tag, attribute map and children.
 *
 * Supported attribute conveniences:
 *   - `class` sets `className`
 *   - `dataset` merges into `el.dataset`
 *   - `on<event>` (e.g. `onclick`) attaches a listener
 *   - boolean `hidden` / `disabled` set the attribute when truthy
 *
 * Children may be strings (text nodes), DOM nodes, or arrays of either.
 *
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs]
 * @param {Array<unknown>} [children]
 * @returns {HTMLElement}
 */
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") {
      el.className = String(value);
    } else if (key === "dataset") {
      Object.assign(el.dataset, value);
    } else if (key.startsWith("on") && typeof value === "function") {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === "hidden" || key === "disabled") {
      el.setAttribute(key, "");
    } else {
      el.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/**
 * Escape a string for safe insertion into HTML.
 * @param {unknown} value
 * @returns {string}
 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}