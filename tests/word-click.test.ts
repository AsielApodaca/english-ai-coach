import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLICK_MAX_DISTANCE_PX,
  CLICK_MAX_DURATION_MS,
  createWordClickHandler,
  isClickGesture,
  wordTokenOf,
} from "../public/ui/word-click.js";
import { wordInteractionAllowed } from "../public/speech/ptt.js";

// ---------------------------------------------------------------------------
// Feature 113 — click on a karaoke word → pronunciation.
//
// Only PURE logic is covered here (no DOM harness exists in this repo): the
// click-vs-drag thresholds, the handler's gate matrix, the isolation from the
// state machine, and the token resolution. The real DOM wiring (document-level
// delegated listeners, CSS `data-interactive` flag) is verified manually and
// pinned by the source assertions at the bottom of this file.
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const viewSrc = readFileSync(join(repoRoot, "public", "ui", "practice-view.js"), "utf8");

/** Fake event target: `closest(sel)` resolves to `el` (whatever the selector). */
function targetOf(el: object | null) {
  return { closest: (_sel: string) => el };
}

/** Fake `.kw` span carrying `data-word`. */
function wordEl(token: string) {
  return { dataset: { word: token }, textContent: token };
}

/** Fake review-mode `.kw` (no dataset): the token comes from `textContent`. */
function reviewEl(text: string) {
  return { textContent: text };
}

/** Fake `.kw-wrap`: the click lands on the wrap, the token lives in its `.kw`. */
function wrapEl(token: string) {
  const kw = wordEl(token);
  return { querySelector: (_sel: string) => kw };
}

/**
 * Test rig: the shared gate as a function of (coachSpeaking × recording), the
 * pronounced words, the dispatched state-machine events and an injected clock
 * for the click/drag threshold.
 */
function rig(opts: { coachSpeaking?: boolean; recording?: boolean } = {}) {
  const allowed = wordInteractionAllowed({
    coachSpeaking: opts.coachSpeaking ?? false,
    recording: opts.recording ?? false,
  });
  const pronounced: string[] = [];
  const dispatched: { type: string }[] = [];
  let clock = 0;
  const handler = createWordClickHandler({
    isAllowed: () => allowed,
    pronounce: (word) => pronounced.push(word),
    dispatch: (event) => dispatched.push(event),
    now: () => clock,
  });
  return {
    handler,
    pronounced,
    dispatched,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

type Rig = ReturnType<typeof rig>;

/** Press on `el` at (x, y). */
function press(r: Rig, el: object, x = 100, y = 50) {
  r.handler.onPointerDown({ target: targetOf(el), clientX: x, clientY: y });
}

/** Click on `el` at (x, y); returns the pronounced token or null. */
function click(r: Rig, el: object | null, x = 100, y = 50) {
  return r.handler.onClick({ target: targetOf(el), clientX: x, clientY: y });
}

// --- constants (spec: 5 px / 400 ms) ---------------------------------------

test("thresholds: 5 px of movement and < 400 ms separate click from drag", () => {
  assert.equal(CLICK_MAX_DISTANCE_PX, 5);
  assert.equal(CLICK_MAX_DURATION_MS, 400);
});

// --- click vs drag ----------------------------------------------------------

test("isClickGesture: within both thresholds → click", () => {
  assert.equal(isClickGesture({ dx: 0, dy: 0, durationMs: 0 }), true);
  assert.equal(isClickGesture({ dx: 5, dy: 0, durationMs: 399 }), true); // boundaries
  assert.equal(isClickGesture({ dx: 0, dy: -5, durationMs: 399 }), true);
  assert.equal(isClickGesture({ dx: 3, dy: 4, durationMs: 100 }), true); // hypot = 5
  assert.equal(isClickGesture({ dx: -2, dy: 1, durationMs: 0 }), true);
});

test("isClickGesture: movement over the threshold → selection, not a click", () => {
  assert.equal(isClickGesture({ dx: 6, dy: 0, durationMs: 50 }), false);
  assert.equal(isClickGesture({ dx: 0, dy: 6, durationMs: 50 }), false);
  // 4 + 4 px diagonal is already > 5 px of radial movement.
  assert.equal(isClickGesture({ dx: 4, dy: 4, durationMs: 50 }), false);
});

test("isClickGesture: a press of 400 ms or more → selection, not a click", () => {
  assert.equal(isClickGesture({ dx: 0, dy: 0, durationMs: 399 }), true);
  assert.equal(isClickGesture({ dx: 0, dy: 0, durationMs: 400 }), false);
  assert.equal(isClickGesture({ dx: 0, dy: 0, durationMs: 4000 }), false);
});

test("isClickGesture: negative durations (clock skew) are clamped, not drags", () => {
  assert.equal(isClickGesture({ dx: 0, dy: 0, durationMs: -100 }), true);
});

test("isClickGesture: defaults (no movement, no elapsed time) are a click", () => {
  assert.equal(isClickGesture(), true);
  assert.equal(isClickGesture({}), true);
});

// --- the handler: click on a word -------------------------------------------

test("click within the threshold pronounces exactly that token", () => {
  const r = rig();
  press(r, wordEl("hello"));
  r.advance(120);
  const out = click(r, wordEl("hello"));
  assert.equal(out, "hello");
  assert.deepEqual(r.pronounced, ["hello"]);
  assert.deepEqual(r.dispatched, [], "no state-machine event was emitted");
});

test("the press record is consumed: one click can never pronounce twice", () => {
  const r = rig();
  press(r, wordEl("once"));
  assert.equal(click(r, wordEl("once")), "once");
  // A second click without a new pointerdown plays nothing.
  assert.equal(click(r, wordEl("once")), null);
  assert.deepEqual(r.pronounced, ["once"]);
});

test("rapid successive clicks each pronounce their own word (no internal queue)", () => {
  const r = rig();
  press(r, wordEl("first"));
  r.advance(30);
  click(r, wordEl("first"));
  press(r, wordEl("second"));
  r.advance(30);
  click(r, wordEl("second"));
  assert.deepEqual(r.pronounced, ["first", "second"]);
  assert.deepEqual(r.dispatched, []);
  // Replacement/overlap semantics belong to BrowserTTS (see browser-tts.test.ts
  // "a newer speak() supersedes the previous one"): the handler never defers.
});

test("drag beyond the movement threshold → NO audio (112 owns the selection)", () => {
  const r = rig();
  press(r, wordEl("drag"), 100, 50);
  r.advance(80);
  const out = click(r, wordEl("drag"), 140, 50); // 40 px of movement
  assert.equal(out, null);
  assert.deepEqual(r.pronounced, []);
  assert.deepEqual(r.dispatched, []);
});

test("press held beyond 400 ms → NO audio (slow drag / long press)", () => {
  const r = rig();
  press(r, wordEl("slow"), 100, 50);
  r.advance(400);
  const out = click(r, wordEl("slow"), 100, 50);
  assert.equal(out, null);
  assert.deepEqual(r.pronounced, []);
});

test("press on one word, click on another → NO audio (cross-word drag)", () => {
  const r = rig();
  press(r, wordEl("Shut"));
  r.advance(60);
  const out = click(r, wordEl("up"));
  assert.equal(out, null);
  assert.deepEqual(r.pronounced, []);
});

test("click with no pointerdown (programmatic click) → NO audio", () => {
  const r = rig();
  const out = click(r, wordEl("stray"));
  assert.equal(out, null);
  assert.deepEqual(r.pronounced, []);
  assert.deepEqual(r.dispatched, []);
});

test("click outside any word (popover, dock, plain line) → NO audio", () => {
  const r = rig();
  press(r, wordEl("hello"));
  r.advance(60);
  // The release landed on the lookup popover: `closest('.kw, .kw-wrap')` null.
  const out = click(r, null);
  assert.equal(out, null);
  assert.deepEqual(r.pronounced, []);
});

// --- gate matrix (coachSpeaking × recording) --------------------------------

test("gate: blocked while the coach speaks or a capture is held; allowed otherwise", () => {
  const matrix: Array<[{ coachSpeaking?: boolean; recording?: boolean }, boolean]> = [
    [{}, true], // turn wait / review / closing panel → allowed
    [{ coachSpeaking: false, recording: false }, true],
    [{ coachSpeaking: true, recording: false }, false], // coach reading
    [{ coachSpeaking: false, recording: true }, false], // PTT capture held
    [{ coachSpeaking: true, recording: true }, false],
  ];
  for (const [state, expected] of matrix) {
    const r = rig(state);
    press(r, wordEl("gated"));
    r.advance(60);
    const out = click(r, wordEl("gated"));
    assert.equal(out, expected ? "gated" : null, `gate failed for ${JSON.stringify(state)}`);
    assert.equal(r.pronounced.length, expected ? 1 : 0, JSON.stringify(state));
    assert.deepEqual(r.dispatched, [], "the click never emits state-machine events");
  }
});

test("gate is checked INSIDE the handler: a programmatic click is blocked even without CSS", () => {
  // The test calls the handlers directly — no element, no stylesheet, no
  // `data-interactive` flag in between: only the handler's own gate decides.
  const blocked = rig({ coachSpeaking: true });
  blocked.handler.onPointerDown({ target: targetOf(wordEl("during-read")), clientX: 10, clientY: 10 });
  const out = blocked.handler.onClick({ target: targetOf(wordEl("during-read")), clientX: 10, clientY: 10 });
  assert.equal(out, null);
  assert.deepEqual(blocked.pronounced, []);

  const recording = rig({ recording: true });
  press(recording, wordEl("during-capture"));
  assert.equal(click(recording, wordEl("during-capture")), null);
  assert.deepEqual(recording.pronounced, []);
});

// --- isolation from the state machine ---------------------------------------

test("every path of the handler leaves the dispatcher untouched", () => {
  const paths: Array<(r: Rig) => void> = [
    (r) => {
      press(r, wordEl("ok"));
      click(r, wordEl("ok"));
    }, // allowed click
    (r) => {
      press(r, wordEl("x"));
      r.advance(900);
      click(r, wordEl("x"));
    }, // slow press
    (r) => {
      press(r, wordEl("a"));
      click(r, wordEl("b"));
    }, // cross-word
    (r) => click(r, wordEl("no-down")), // no pointerdown
    (r) => click(r, null), // outside a word
  ];
  for (const run of paths) {
    const idle = rig();
    run(idle);
    assert.deepEqual(idle.dispatched, [], "TTS_END / phase events must never be emitted");
  }
  const speaking = rig({ coachSpeaking: true });
  press(speaking, wordEl("gated"));
  click(speaking, wordEl("gated"));
  assert.deepEqual(speaking.dispatched, [], "blocked clicks must not dispatch either");
});

// --- token resolution -------------------------------------------------------

test("wordTokenOf: data-word wins over textContent (contractions kept verbatim)", () => {
  assert.equal(wordTokenOf(targetOf(wordEl("don't"))), "don't");
  assert.equal(wordTokenOf(targetOf(wordEl("Shut"))), "Shut");
  assert.equal(wordTokenOf(targetOf(wordEl("  spaced  "))), "spaced");
});

test("wordTokenOf: review-mode spans (no dataset) fall back to textContent", () => {
  assert.equal(wordTokenOf(targetOf(reviewEl("Great"))), "Great");
  assert.equal(wordTokenOf(targetOf({ textContent: "  " })), "");
});

test("wordTokenOf: a click on the .kw-wrap resolves to its word span", () => {
  assert.equal(wordTokenOf(targetOf(wrapEl("relax"))), "relax");
});

test("wordTokenOf: targets outside a word resolve to empty", () => {
  assert.equal(wordTokenOf(targetOf(null)), "");
  assert.equal(wordTokenOf(null), "");
  assert.equal(wordTokenOf(undefined), "");
  assert.equal(wordTokenOf("not-an-element"), "");
  assert.equal(wordTokenOf({}), "");
  assert.equal(wordTokenOf({ closest: () => ({ textContent: "   " }) }), "");
});

// --- integration pin (no DOM harness): the wiring in practice-view.js -------

test("practice-view: shared gate + audio-only side-effect, never the flow", () => {
  // One source of truth for 112 and 113: `canInteractWithWords()`.
  assert.match(viewSrc, /createWordClickHandler\(\{[^}]*isAllowed:\s*canInteractWithWords/);
  assert.match(viewSrc, /createWordClickHandler\(\{[^}]*pronounce:\s*pronounceWord/);
  assert.match(viewSrc, /initLookupPopover\(\{\s*isAllowed:\s*canInteractWithWords\s*\}\)/);
  // The CSS mirror of that gate lives on the book container.
  assert.match(viewSrc, /setAttribute\("data-interactive"/);

  // `pronounceWord` is the whole side-effect: it must play through the
  // existing TTS chain and stay out of the state machine / DOM rendering.
  const body = /function pronounceWord\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(viewSrc)?.[0] ?? "";
  assert.ok(body, "pronounceWord must exist in practice-view.js");
  assert.match(body, /tts\.speak\(/, "the existing BrowserTTS chain is used");
  assert.doesNotMatch(body, /new Audio\(/, "no third audio channel");
  assert.doesNotMatch(
    body,
    /setPhase\(|flowToken|captureAttempt|await speak|stopKaraokeRead|activePtt|render/i,
    "the click must never advance, cancel or re-render the flow",
  );
});
