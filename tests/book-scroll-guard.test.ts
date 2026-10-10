import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const viewSrc = readFileSync(join(repoRoot, "public", "ui", "practice-view.js"), "utf8");

/**
 * Indented body of a top-level `function <name>(...) { ... }` in
 * practice-view.js, from the opening brace to the closing brace at column 0.
 * No DOM harness exists for the view, so these tests pin the wiring at the
 * source level (same approach as karaoke-schedule / word-click pins).
 */
function functionBody(name: string): string {
  const start = viewSrc.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in practice-view.js`);
  const open = viewSrc.indexOf("{", start);
  const close = viewSrc.indexOf("\n}", open);
  assert.ok(open >= 0 && close > open, `${name} must have a readable body`);
  return viewSrc.slice(open + 1, close);
}

// ---------------------------------------------------------------------------
// PTT SPACE: consume the auto-repeat (spec 111 "espacio no scrollea", fix for
// the oscillation against the live auto-scroll of feature 121)
// ---------------------------------------------------------------------------

test("onPttKeyDown: preventDefault runs before the auto-repeat guard", () => {
  const body = functionBody("onPttKeyDown");
  const prevent = body.indexOf("event.preventDefault()");
  const repeat = body.indexOf("event.repeat");
  assert.ok(prevent >= 0, "an armed turn must consume the keydown");
  assert.ok(repeat > prevent, "repeat keydowns must be consumed too (their default action scrolls)");
});

test("onPttKeyDown: auto-repeat still never starts a second capture", () => {
  const body = functionBody("onPttKeyDown");
  assert.match(body, /if \(event\.repeat\) return;/, "repeat must return before press()");
  assert.ok(
    body.indexOf("event.repeat") < body.indexOf('activePtt.press("space")'),
    "the repeat guard must sit before the press",
  );
});

test("onPttKeyDown: text entry and unarmed turns keep SPACE untouched", () => {
  const body = functionBody("onPttKeyDown");
  assert.match(body, /isTextEntryTarget\(event\.target\)/, "inputs keep typing spaces");
  assert.match(body, /if \(!activePtt\) return;/, "outside a capture SPACE keeps its default meaning");
});

// ---------------------------------------------------------------------------
// Book scroll guard (feature 121): with a selection inside the model answer,
// only the mouse wheel may scroll it — keyboard defaults are consumed
// ---------------------------------------------------------------------------

test("book scroll guard: registered on window keydown next to the PTT handlers", () => {
  assert.match(
    viewSrc,
    /window\.addEventListener\("keydown", onBookScrollGuard\)/,
    "onBookScrollGuard must be wired at init",
  );
});

test("book scroll guard: blocks SPACE and the scroll keys, scoped to .karaoke-book", () => {
  const body = functionBody("onBookScrollGuard");
  assert.match(body, /isSpaceKey\(event\)/, "SPACE is a scroll key");
  assert.match(body, /SCROLL_KEYS\.has\(event\.key\)/, "arrows/PageUp/PageDown/Home/End are scroll keys");
  assert.match(
    body,
    /closest\("\.karaoke-book"\)/,
    "the guard must only act while the selection lives in the model answer",
  );
  assert.match(body, /event\.preventDefault\(\)/, "the keyboard default must be consumed");
  assert.match(
    body,
    /event\.defaultPrevented/,
    "already-handled events (PTT press) must not be re-processed",
  );
  assert.match(body, /isTextEntryTarget\(event\.target\)/, "inputs keep their caret/SPACE keys");
});

test("book scroll guard: the scroll-key set covers the standard browser scroll keys", () => {
  const setMatch = viewSrc.match(/const SCROLL_KEYS = new Set\(\[([^\]]+)\]\)/);
  assert.ok(setMatch, "SCROLL_KEYS must be declared");
  for (const key of ["PageUp", "PageDown", "ArrowUp", "ArrowDown", "Home", "End"]) {
    assert.ok(setMatch[1].includes(`"${key}"`), `${key} must be in SCROLL_KEYS`);
  }
});
