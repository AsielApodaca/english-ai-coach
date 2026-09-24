/**
 * Small UI builders for the settings sub-tabs (feature 108).
 *
 * Each builder returns a DOM node; the tab modules compose them into
 * sections. All controls follow the design system (switch toggles, segmented
 * controls, ghost buttons) and are accessible (labels + focusable).
 */

import { h } from "../dom.js";

/** A titled section wrapping a list of setting rows. */
export function settingsSection(title, rows) {
  return h("div", { class: "settings-section" }, [
    h("div", { class: "settings-section-title" }, title),
    h("div", { class: "settings-section-rows" }, rows),
  ]);
}

/** One setting row: label + hint on the left, control on the right. */
export function settingRow({ label, hint, control }) {
  return h("div", { class: "setting-row" }, [
    h("div", { class: "setting-info" }, [
      h("div", { class: "setting-label" }, label),
      ...(hint ? [h("div", { class: "setting-hint" }, hint)] : []),
    ]),
    h("div", { class: "setting-control" }, control),
  ]);
}

/** A switch toggle (checkbox styled as a pill). */
export function toggleControl({ checked, onChange, label }) {
  const input = h("input", {
    type: "checkbox",
    class: "switch-input",
    role: "switch",
    "aria-label": label ?? "",
    ...(checked ? { checked: "" } : {}),
  });
  input.addEventListener("change", () => onChange(input.checked));
  return h("label", { class: "switch" }, [input, h("span", { class: "switch-track" })]);
}

/** A segmented control (one active option). */
export function segmentedControl({ options, value, onChange, label }) {
  const group = h("div", { class: "segmented", role: "group", "aria-label": label ?? "" });
  for (const opt of options) {
    const btn = h(
      "button",
      {
        type: "button",
        class: "segmented-btn",
        dataset: { value: String(opt.value) },
        ...(opt.value === value ? { "aria-pressed": "true" } : {}),
      },
      opt.label,
    );
    if (opt.value === value) btn.classList.add("active");
    btn.addEventListener("click", () => {
      for (const b of group.querySelectorAll(".segmented-btn")) {
        b.classList.toggle("active", b === btn);
        b.setAttribute("aria-pressed", String(b === btn));
      }
      onChange(opt.value);
    });
    group.appendChild(btn);
  }
  return group;
}

/** A native select. */
export function selectControl({ options, value, onChange, label }) {
  const select = h(
    "select",
    { class: "settings-select", "aria-label": label ?? "" },
    options.map((o) => h("option", { value: String(o.value) }, o.label)),
  );
  select.value = String(value);
  select.addEventListener("change", () => onChange(select.value));
  return select;
}

/** A single-line text input. */
export function textControl({ value, placeholder, onChange, label }) {
  const input = h("input", {
    type: "text",
    class: "settings-input",
    placeholder: placeholder ?? "",
    "aria-label": label ?? "",
    ...(value ? { value } : {}),
  });
  input.addEventListener("input", () => onChange(input.value));
  return input;
}

/** A number input (used for the adaptive thresholds). */
export function numberControl({ value, min, max, onChange, label }) {
  const input = h("input", {
    type: "number",
    class: "settings-input settings-number",
    min: String(min ?? 0),
    max: String(max ?? 100),
    "aria-label": label ?? "",
    ...(value !== undefined && value !== null ? { value: String(value) } : {}),
  });
  input.addEventListener("change", () => onChange(Number(input.value)));
  return input;
}

/** A multi-line textarea. */
export function textareaControl({ value, placeholder, onChange, label, rows = 3 }) {
  const ta = h(
    "textarea",
    {
      class: "settings-textarea",
      placeholder: placeholder ?? "",
      rows: String(rows),
      "aria-label": label ?? "",
    },
    value ?? "",
  );
  ta.addEventListener("input", () => onChange(ta.value));
  return ta;
}