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
  tokensFromRange,
  wordTokenOf,
} from "../public/ui/word-click.js";
import { wordInteractionAllowed } from "../public/speech/ptt.js";

// ---------------------------------------------------------------------------
// Feature 113 — click on a karaoke word → pronunciation, click on an active
// selection → the whole phrase as one utterance.
//
// Only PURE logic is covered here (no DOM harness exists in this repo): the
// click-vs-drag thresholds, the handler's gate matrix, the selection path and
// its precedence over the threshold, the isolation from the state machine, and
// the token resolution (word path + `tokensFromRange`). The real DOM wiring
// (document-level delegated listeners, CSS `data-interactive` flag) is
// verified manually and pinned by the source assertions at the bottom of this
// file.
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const viewSrc = readFileSync(join(repoRoot, "public", "ui", "practice-view.js"), "utf8");
const popoverSrc = readFileSync(join(repoRoot, "public", "ui", "lookup-popover.js"), "utf8");

/** Fake event target: `closest(sel)` resolves to `el` (whatever the selector). */
function targetOf(el: object | null) {
  return { closest: (_sel: string) => el };
}

/**
 * Fake event target INSIDE the word surface: tagged `inBook` (the marker
 * `bookScope` reads) while still resolving `closest` for `wordTokenOf`.
 */
function bookTargetOf(el: object | null) {
  return { inBook: true, closest: (_sel: string) => el };
}

/** `isScope` matching only the book-tagged targets of `bookTargetOf`. */
function bookScope(target: unknown): boolean {
  return Boolean(target && typeof target === "object" && "inBook" in target && target.inBook);
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

/** Fake Range: `intersectsNode` is true only for the listed elements. */
function fakeRange(hits: object[]) {
  return { intersectsNode: (el: object) => hits.includes(el) };
}

/**
 * Test rig: the shared gate as a function of (coachSpeaking × recording), the
 * pronounced calls (one entry per `pronounce()` call, each an array — the
 * word path pushes 1 token, the selection path the whole token array), the
 * dispatched state-machine events, the optional selection/scope probes of the
 * selection path and an injected clock for the click/drag threshold.
 */
function rig(opts: {
  coachSpeaking?: boolean;
  recording?: boolean;
  selection?: () => string[];
  isScope?: (target: unknown) => boolean;
} = {}) {
  const allowed = wordInteractionAllowed({
    coachSpeaking: opts.coachSpeaking ?? false,
    recording: opts.recording ?? false,
  });
  const pronouncedCalls: string[][] = [];
  const dispatched: { type: string }[] = [];
  let clock = 0;
  const handler = createWordClickHandler({
    isAllowed: () => allowed,
    pronounce: (words: string[]) => pronouncedCalls.push(words),
    // Defaults preserve the word-click-only behavior (selection path off).
    selection: opts.selection ?? (() => []),
    isScope: opts.isScope ?? (() => false),
    dispatch: (event) => dispatched.push(event),
    now: () => clock,
  });
  return {
    handler,
    /** One entry per pronounce() call, each the exact array passed. */
    pronouncedCalls,
    /** Flattened view of every pronounced token (old single-word assertions). */
    get pronounced(): string[] {
      return pronouncedCalls.flat();
    },
    dispatched,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

type Rig = ReturnType<typeof rig>;

/** Rig with an active 2-word selection AND the book scope enabled. */
function selectionRig(opts: { coachSpeaking?: boolean; recording?: boolean } = {}): Rig {
  return rig({ ...opts, selection: () => ["Shut", "up"], isScope: bookScope });
}

/** Press on `el` at (x, y) — outside the word surface (no scope probe). */
function press(r: Rig, el: object | null, x = 100, y = 50) {
  r.handler.onPointerDown({ target: targetOf(el), clientX: x, clientY: y });
}

/** Press on `el` at (x, y) INSIDE the word surface (book/review). */
function pressInBook(r: Rig, el: object | null, x = 100, y = 50) {
  r.handler.onPointerDown({ target: bookTargetOf(el), clientX: x, clientY: y });
}

/** Click on `el` at (x, y); returns the pronounced tokens or null. */
function click(r: Rig, el: object | null, x = 100, y = 50): string[] | null {
  return r.handler.onClick({ target: targetOf(el), clientX: x, clientY: y });
}

/** Click on `el` at (x, y) INSIDE the word surface; tokens or null. */
function clickInBook(r: Rig, el: object | null, x = 100, y = 50): string[] | null {
  return r.handler.onClick({ target: bookTargetOf(el), clientX: x, clientY: y });
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
  assert.deepEqual(out, ["hello"]);
  assert.deepEqual(r.pronouncedCalls, [["hello"]]);
  assert.deepEqual(r.dispatched, [], "no state-machine event was emitted");
});

test("the press record is consumed: one click can never pronounce twice", () => {
  const r = rig();
  press(r, wordEl("once"));
  assert.deepEqual(click(r, wordEl("once")), ["once"]);
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
    assert.deepEqual(out, expected ? ["gated"] : null, `gate failed for ${JSON.stringify(state)}`);
    assert.equal(r.pronouncedCalls.length, expected ? 1 : 0, JSON.stringify(state));
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

// --- selection path: click an active selection → the whole phrase -----------

test("selection path: in-scope press + click with a selection → ONE pronounce call with the exact token array", () => {
  const r = rig({ selection: () => ["Shut", "up"], isScope: bookScope });
  pressInBook(r, wordEl("Shut"));
  r.advance(150);
  const out = clickInBook(r, wordEl("up"), 180, 50); // 80 px of drag
  assert.deepEqual(out, ["Shut", "up"]);
  assert.deepEqual(
    r.pronouncedCalls,
    [["Shut", "up"]],
    "called exactly once, with the whole selection as one array",
  );
  assert.deepEqual(r.dispatched, [], "the selection path is isolated from the flow");
});

test("selection path: PRECEDENCE — movement far beyond the threshold still pronounces", () => {
  // Selecting text always breaks 5 px AND 400 ms; without precedence over the
  // click-vs-drag threshold the selection could never be pronounced.
  const r = rig({ selection: () => ["please", "shut", "up"], isScope: bookScope });
  pressInBook(r, wordEl("please"), 10, 10);
  r.advance(900); // way past 400 ms
  const out = clickInBook(r, wordEl("up"), 320, 140); // way past 5 px
  assert.deepEqual(out, ["please", "shut", "up"]);
  assert.deepEqual(r.pronouncedCalls, [["please", "shut", "up"]]);
  assert.deepEqual(r.dispatched, []);
});

test("selection path: the gate blocks it exactly like a word click", () => {
  for (const state of [{ coachSpeaking: true }, { recording: true }]) {
    const r = rig({ ...state, selection: () => ["Shut", "up"], isScope: bookScope });
    pressInBook(r, wordEl("Shut"));
    r.advance(60);
    const out = clickInBook(r, wordEl("up"), 180, 50);
    assert.equal(out, null, JSON.stringify(state));
    assert.deepEqual(r.pronouncedCalls, [], JSON.stringify(state));
    assert.deepEqual(r.dispatched, [], "blocked selection clicks must not dispatch");
  }
});

test("selection path: a press outside the book is ignored even with a selection active", () => {
  const r = rig({ selection: () => ["Shut", "up"], isScope: bookScope });
  press(r, null); // pointerdown on the dock: no token, out of scope → no record
  r.advance(60);
  const out = clickInBook(r, wordEl("Shut"));
  assert.equal(out, null);
  assert.deepEqual(r.pronouncedCalls, []);
  assert.deepEqual(r.dispatched, []);
});

test("selection path: a click whose target leaves the book (popover) does NOT pronounce", () => {
  const r = rig({ selection: () => ["Shut", "up"], isScope: bookScope });
  pressInBook(r, wordEl("Shut"));
  r.advance(60);
  const out = click(r, null); // release over the lookup popover: target out of scope
  assert.equal(out, null);
  assert.deepEqual(r.pronouncedCalls, []);
  assert.deepEqual(r.dispatched, []);
});

test("selection path: an EMPTY selection falls back to the word path", () => {
  const r = rig({ selection: () => [], isScope: bookScope });
  // A plain word click has no selection → the single word plays.
  pressInBook(r, wordEl("hello"));
  r.advance(60);
  assert.deepEqual(clickInBook(r, wordEl("hello")), ["hello"]);
  // A drag with NO selection still yields no audio (112 owns it).
  pressInBook(r, wordEl("drag"));
  r.advance(60);
  assert.equal(clickInBook(r, wordEl("drag"), 160, 50), null);
  assert.deepEqual(r.pronouncedCalls, [["hello"]]);
  assert.deepEqual(r.dispatched, []);
});

// --- isolation from the state machine ---------------------------------------

test("every path of the handler leaves the dispatcher untouched", () => {
  const paths: Array<(r: Rig) => void> = [
    (r) => {
      press(r, wordEl("ok"));
      click(r, wordEl("ok"));
    }, // allowed word click
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
    (r) => {
      pressInBook(r, wordEl("Shut"));
      r.advance(300);
      clickInBook(r, wordEl("up"), 200, 100);
    }, // SELECTION path (drag beyond the threshold, selection active)
    (r) => {
      pressInBook(r, wordEl("Shut"));
      r.advance(60);
      clickInBook(r, null); // selection path, release out of scope
    },
    (r) => {
      press(r, null); // press out of scope with a selection active
      r.advance(60);
      clickInBook(r, wordEl("Shut"));
    },
  ];
  for (const run of paths) {
    const idle = selectionRig();
    run(idle);
    assert.deepEqual(idle.dispatched, [], "TTS_END / phase events must never be emitted");
  }
  // Sanity: the selection entries above really took the selection path.
  const exercised = selectionRig();
  pressInBook(exercised, wordEl("Shut"));
  exercised.advance(300);
  clickInBook(exercised, wordEl("up"), 200, 100);
  assert.deepEqual(exercised.pronouncedCalls, [["Shut", "up"]]);

  const speaking = selectionRig({ coachSpeaking: true });
  pressInBook(speaking, wordEl("gated"));
  speaking.advance(60);
  clickInBook(speaking, wordEl("up"), 200, 100);
  assert.deepEqual(speaking.dispatched, [], "blocked clicks must not dispatch either");
  assert.deepEqual(speaking.pronouncedCalls, []);
});

// --- token resolution (word path) -------------------------------------------

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

// --- tokensFromRange (selection → phrase) -----------------------------------

test("tokensFromRange: only the elements the range intersects contribute tokens", () => {
  const a = wordEl("Please");
  const b = wordEl("shut");
  const c = wordEl("up");
  assert.deepEqual(tokensFromRange(fakeRange([b, c]), [a, b, c]), ["shut", "up"]);
  assert.deepEqual(tokensFromRange(fakeRange([a]), [a, b, c]), ["Please"]);
  assert.deepEqual(tokensFromRange(fakeRange([]), [a, b, c]), []); // empty range
});

test("tokensFromRange: dataset.word wins over textContent", () => {
  const el = { dataset: { word: "don't" }, textContent: "dont" };
  assert.deepEqual(tokensFromRange(fakeRange([el]), [el]), ["don't"]);
});

test("tokensFromRange: contractions and casing preserved verbatim (no normalization)", () => {
  const contraction = wordEl("don't");
  const cased = wordEl("SHUT");
  const review = reviewEl(" Great ");
  // `phraseFromRange` (112) would lowercase/strip these for its cache key;
  // the TTS needs the exact rendered tokens instead.
  assert.deepEqual(
    tokensFromRange(fakeRange([contraction, cased, review]), [contraction, cased, review]),
    ["don't", "SHUT", "Great"],
  );
});

test("tokensFromRange: whitespace is trimmed and blank elements are skipped", () => {
  const spaced = wordEl("  spaced  ");
  const blank = { textContent: "   " };
  const noDataset = reviewEl("Great");
  assert.deepEqual(tokensFromRange(fakeRange([spaced, blank, noDataset]), [spaced, blank, noDataset]), [
    "spaced",
    "Great",
  ]);
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

test("practice-view: a selection is pronounced as ONE array in a single speak() call", () => {
  const body = /function pronounceWord\([^)]*\)\s*\{[\s\S]*?\n\}/.exec(viewSrc)?.[0] ?? "";
  assert.ok(body, "pronounceWord must exist in practice-view.js");
  // BrowserTTS accepts string[] → one /api/tts request with `segments` params.
  assert.equal(
    (body.match(/tts\.speak\(/g) ?? []).length,
    1,
    "exactly one speak() call — the whole array, never a per-word request",
  );
  assert.match(body, /tts\.speak\(list/, "the filtered array goes to speak() as-is");
  assert.doesNotMatch(body, /for\s*\(|while\s*\(|forEach/, "no per-word loop");
  // The selection/scope probes are wired into the handler, DOM side.
  assert.match(viewSrc, /createWordClickHandler\(\{[^}]*selection:\s*selectedWordTokens/);
  assert.match(viewSrc, /createWordClickHandler\(\{[^}]*isScope:\s*isWordScope/);
  assert.match(viewSrc, /tokensFromRange\(range/);
});

test("lookup-popover: ANY press inside the book keeps the card open (112+113 coexist)", () => {
  // Selection clicks often land on line gaps (no `.kw`), so the press guard
  // must match the whole surface — otherwise the card would close exactly as
  // the selection audio starts.
  assert.match(popoverSrc, /WORD_PRESS_SEL = "\.karaoke-book, \.review-words"/);
  assert.match(popoverSrc, /target\.closest\(WORD_PRESS_SEL\)/);
});
