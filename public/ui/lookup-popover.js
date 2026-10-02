/**
 * Word lookup popover (feature 112 / CU2) — the little dictionary card that
 * appears when the user hovers a karaoke word or drags a selection.
 *
 * Architecture: ONE reusable popover node appended to `<body>` and driven by
 * document-level DELEGATED listeners, so it survives every `rebuildBook()`
 * without leaking per-word nodes (spec 112 non-functional requirement).
 *
 * Triggers:
 *   - hover: `pointerover` on `.kw` with a ~300 ms intent delay, only on real
 *     hover pointers (`(hover: hover)`; touch relies on text selection),
 *     suppressed while a karaoke selection is active;
 *   - selection: `mouseup` with a native selection inside `.karaoke-book` or
 *     `.review-words` — 1 token behaves like a word, ≥ 2 tokens resolve the
 *     whole phrase (idioms like "shut up");
 *   - close: popover `mouseleave` with a ~150 ms grace, press OUTSIDE the
 *     book surface (dock, buttons, overlay), Escape, phase change / flow
 *     cancel (the practice view calls `closeLookupPopover()`), or the
 *     interaction gate flipping closed (coach speaking / PTT capture — polled
 *     while open). Presses INSIDE the book/review surface never close the
 *     card: a word click and a selection click both pronounce (feature 113)
 *     and the card must stay open while the audio plays.
 *
 * It never intercepts `click` (feature 113 owns click → pronunciation; a
 * press inside the book deliberately keeps the card open so audio and meaning
 * coexist), never touches the `.kw-*` color/animation classes, and never
 * prevents the native selection used to copy text.
 *
 * Resolution goes through `GET /api/lookup`; results are cached in an
 * in-memory Map + `localStorage` (`engcoach.lookup.<normalized>`, capped at
 * ~500 entries) so repeats are instant and MyMemory's daily quota stretches.
 * Failures degrade to "Significado no disponible" — never a thrown error.
 */

import { h } from "./dom.js";

/** Hover intent delay before the popover opens (spec 112: ~300 ms). */
const HOVER_INTENT_MS = 300;

/** Grace after leaving the word/popover before it closes (~150 ms). */
const LEAVE_GRACE_MS = 150;

/** Show the loading skeleton only when the response takes > ~200 ms. */
const LOADING_MS = 200;

/** Gate poll while open: close as soon as coach/capture disables lookup. */
const GATE_POLL_MS = 250;

/** Client-side mirror of the server limit (spec 112: text ≤ 60 chars). */
const MAX_CHARS = 60;

/** localStorage namespace for cached entries (spec 112 key format). */
const CACHE_PREFIX = "engcoach.lookup.";

/** Client cache cap in entries (spec 112: ~500). */
const CACHE_CAP = 500;

/** Selector of the single popover node (outside-press guard). */
const POPOVER_SEL = ".lookup-popover";

/** Containers the selection trigger accepts (karaoke book + review mode). */
const SCOPE_SEL = ".karaoke-book, .review-words";

/** Word spans the selection reconstruction reads, in document order. */
const WORD_SEL = ".karaoke-book .kw, .review-words .kw";

/**
 * Word SURFACE a press must NOT close the card on: the whole book/review
 * container (element or any descendant via `closest`). Clicking a word
 * pronounces it and clicking an ACTIVE selection pronounces the whole phrase
 * (feature 113) — both must keep the card open while the audio plays. The
 * surface is matched broadly on purpose: a selection click often lands on a
 * line gap (`.karaoke-line`, the `.review-words` container, text nodes between
 * review words) where no `.kw`/`.kw-wrap` selector would match, and closing
 * there would kill the card exactly as the selection audio starts. Presses
 * outside the surface (dock, buttons, overlay) still close it.
 */
const WORD_PRESS_SEL = ".karaoke-book, .review-words";

// --- module state (single popover instance) --------------------------------

/** @type {HTMLElement|null} the one reusable node */
let pop = null;
/** @type {HTMLElement|null} */ let loadingEl = null;
/** @type {HTMLElement|null} */ let bodyEl = null;
/** @type {HTMLElement|null} */ let errorEl = null;

/** Gate injected by the practice view: false while coach speaks / captures. */
let isAllowedFn = () => true;
/** True on pointers with real hover (touch opens the popover via selection). */
let hoverCapable = false;
let initialized = false;

let hoverTimer = null;
let leaveTimer = null;
let loadingTimer = null;
let gateTimer = null;

/** Bumped on every open/close so stale responses are ignored. */
let requestId = 0;
let isOpen = false;
/** Normalized text of the current popover (dedupe hover/selection). */
let currentText = "";
/** Fixed-position anchor of the current popover. */
let anchorRect = null;
/** True while a karaoke selection owns the popover (hover stays off). */
let selectionActive = false;

/** In-memory client cache (fast path before localStorage). */
const memoryCache = new Map();

// ---------------------------------------------------------------------------
// Normalization (mirror of `normalizeLookupText` in src/lib/lookup.ts — no
// build step to share it, same rules so the cache keys line up)
// ---------------------------------------------------------------------------

/**
 * Normalize raw text into the canonical lookup key: collapse whitespace
 * (multi-line selections included), strip edge punctuation, lowercase.
 *
 * @param {unknown} raw - selection text / `data-word` / word text
 * @returns {string} normalized text, or "" when there is nothing to look up
 */
export function normalizeLookupText(raw) {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "")
    .toLowerCase();
}

/**
 * Rebuild the lookup phrase from the word spans a selection Range covers
 * (review fix #2). `Range.toString()` is unusable in the karaoke book: lines
 * insert NO whitespace text nodes between `.kw-wrap`s and `.kw-ipa` annotations
 * sit inside the Range, so the raw string reads like `Shut~shuhtupuhpand` —
 * one bogus token the server rejects (and across lines: `easy.EE·zeePlease`).
 *
 * Instead: every `.kw` span the Range intersects (document order) contributes
 * its `data-word` (or `textContent` in review mode, where spans carry no
 * dataset), each token normalized like the server, joined with single spaces.
 * A drag that starts mid-word therefore selects whole words only.
 *
 * Deliberately pure over its inputs — the range only needs `intersectsNode`
 * and the elements only `dataset.word`/`textContent` — so tests can drive it
 * with fakes instead of a real DOM.
 *
 * @param {{ intersectsNode(el: object): boolean }} range - the selection range
 * @param {Iterable<object>} elements - candidate `.kw` spans in document order
 * @returns {string} normalized phrase, or "" when no span intersects
 */
export function phraseFromRange(range, elements) {
  const words = [];
  for (const el of elements) {
    if (!range.intersectsNode(el)) continue;
    const raw =
      el.dataset && typeof el.dataset.word === "string" && el.dataset.word
        ? el.dataset.word
        : el.textContent;
    const word = normalizeLookupText(raw);
    if (word) words.push(word);
  }
  return words.join(" ");
}

/**
 * True when a lookup entry carries BOTH gloss and Spanish translation — the
 * only entries worth caching on the client (mirrors the server rule): a
 * partial would freeze a missing field forever instead of letting the next
 * attempt heal it (review fix #5).
 *
 * @param {{ gloss?: unknown, example?: unknown, translationEs?: unknown }} [entry]
 * @returns {boolean}
 */
export function isCompleteEntry(entry) {
  const gloss = entry && typeof entry.gloss === "string" ? entry.gloss.trim() : "";
  const translation =
    entry && typeof entry.translationEs === "string" ? entry.translationEs.trim() : "";
  return Boolean(gloss && translation);
}

// ---------------------------------------------------------------------------
// Client cache
// ---------------------------------------------------------------------------

/**
 * Read a cached lookup (memory Map first, then `localStorage`).
 * Only complete entries (`isCompleteEntry`) are served.
 *
 * @param {string} text - normalized lookup text
 * @returns {object|null} the cached `{ ok, kind, source, entry }` payload
 */
function cacheGet(text) {
  let value = memoryCache.get(text) ?? null;
  if (!value) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + text);
      if (raw) {
        const parsed = JSON.parse(raw);
        // Complete entries only: gloss-less / translation-less payloads are
        // transient (they could never heal) — treat them as a miss.
        if (parsed && parsed.ok === true && isCompleteEntry(parsed.entry)) value = parsed;
      }
    } catch {
      // private mode / corrupt entry — treat as a miss
    }
  }
  if (value) {
    // Refresh recency for both layers.
    memoryCache.delete(text);
    memoryCache.set(text, value);
  }
  return value;
}

/**
 * Store a successful lookup in both cache layers (errors are never stored,
 * and partial entries — missing gloss or translation — are skipped so the
 * next attempt can heal them; review fix #5).
 *
 * @param {string} text - normalized lookup text
 * @param {object} payload - the `{ ok: true, ... }` response
 */
function cacheSet(text, payload) {
  if (!payload || payload.ok !== true || !isCompleteEntry(payload.entry)) return;
  memoryCache.delete(text);
  memoryCache.set(text, payload);
  while (memoryCache.size > CACHE_CAP) {
    const oldest = memoryCache.keys().next();
    if (oldest.done) break;
    memoryCache.delete(oldest.value);
  }
  try {
    localStorage.setItem(CACHE_PREFIX + text, JSON.stringify(payload));
    pruneLocalStorage();
  } catch {
    // storage full / private mode — the memory Map still works
  }
}

/** Drop the oldest `engcoach.lookup.*` entries beyond the cap. */
function pruneLocalStorage() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(CACHE_PREFIX)) keys.push(key);
    }
    // localStorage enumerates in insertion order: the head is the oldest.
    while (keys.length > CACHE_CAP) {
      const victim = keys.shift();
      if (victim === undefined) break;
      localStorage.removeItem(victim);
    }
  } catch {
    // ignore — pruning is best-effort
  }
}

// ---------------------------------------------------------------------------
// Lookup request
// ---------------------------------------------------------------------------

/**
 * Resolve the popover content: client cache → `GET /api/lookup`.
 * Never throws; returns `null` on invalid input or any failure so the caller
 * can render the degraded message.
 *
 * @param {string} rawText - selected/hovered text
 * @returns {Promise<{ok: true, kind: string, source: string, entry: object}|null>}
 */
async function lookupRequest(rawText) {
  const text = normalizeLookupText(rawText);
  if (!text || text.length > MAX_CHARS) return null;
  const cached = cacheGet(text);
  if (cached) return cached;
  let json = null;
  try {
    const res = await fetch(`/api/lookup?text=${encodeURIComponent(text)}`);
    json = await res.json();
  } catch {
    return null;
  }
  if (!json || json.ok !== true || !json.entry) return null;
  const payload = {
    ok: true,
    kind: json.kind === "phrase" ? "phrase" : "word",
    source: typeof json.source === "string" ? json.source : "llm",
    entry: json.entry,
  };
  cacheSet(text, payload);
  return payload;
}

// ---------------------------------------------------------------------------
// DOM: the single popover node
// ---------------------------------------------------------------------------

/** Create the popover node once (and re-attach it if the body was replaced). */
function ensureNode() {
  if (pop && document.body.contains(pop)) return;
  loadingEl = h("div", { class: "lookup-loading", hidden: true }, [
    h("span", { class: "lookup-skeleton lookup-skeleton-wide" }),
    h("span", { class: "lookup-skeleton lookup-skeleton-narrow" }),
  ]);
  bodyEl = h("div", { class: "lookup-body", hidden: true });
  errorEl = h("div", { class: "lookup-error", hidden: true }, "Significado no disponible");
  pop = h("div", { class: "lookup-popover", role: "tooltip", hidden: true }, [loadingEl, bodyEl, errorEl]);
  // Grace: moving from the word into the popover must not close it.
  pop.addEventListener("mouseenter", () => clearTimeout(leaveTimer));
  pop.addEventListener("mouseleave", () => scheduleClose());
  document.body.appendChild(pop);
}

/**
 * Install the delegated listeners (idempotent — safe to call from init).
 *
 * @param {{ isAllowed?: () => boolean }} [opts]
 *   `isAllowed` — gate consulted before opening and polled while open
 *   (false while the coach reads or a PTT capture is held, feature 111).
 */
export function initLookupPopover(opts = {}) {
  if (typeof opts.isAllowed === "function") isAllowedFn = opts.isAllowed;
  if (initialized) return;
  initialized = true;
  hoverCapable =
    typeof window.matchMedia === "function" && window.matchMedia("(hover: hover)").matches;
  ensureNode();
  document.addEventListener("pointerover", onPointerOver);
  document.addEventListener("pointerout", onPointerOut);
  document.addEventListener("mousedown", onPointerDown);
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("selectionchange", onSelectionChange);
  window.addEventListener("resize", () => closeLookupPopover());
  // Capture phase: the karaoke book scrolls inside its own container.
  window.addEventListener("scroll", () => closeLookupPopover(), true);
}

/** Close the popover and cancel every pending timer/request. */
export function closeLookupPopover() {
  requestId++;
  isOpen = false;
  currentText = "";
  anchorRect = null;
  clearTimeout(hoverTimer);
  hoverTimer = null;
  clearTimeout(leaveTimer);
  leaveTimer = null;
  clearTimeout(loadingTimer);
  loadingTimer = null;
  clearInterval(gateTimer);
  gateTimer = null;
  if (pop) pop.hidden = true;
}

/** Arm the close timer (grace so the pointer can reach the popover). */
function scheduleClose() {
  clearTimeout(leaveTimer);
  leaveTimer = setTimeout(() => {
    leaveTimer = null;
    closeLookupPopover();
  }, LEAVE_GRACE_MS);
}

/** While open, close as soon as the interaction gate goes back to false. */
function startGateWatch() {
  clearInterval(gateTimer);
  gateTimer = setInterval(() => {
    if (!isOpen) {
      clearInterval(gateTimer);
      gateTimer = null;
      return;
    }
    if (!isAllowedFn()) closeLookupPopover();
  }, GATE_POLL_MS);
}

// --- rendering --------------------------------------------------------------

function clearChildren() {
  // replaceChildren (not just hiding) so repeated renders never accumulate
  // fields: renderEntry appends 3 nodes every time (review: 3 → 6 → 9).
  bodyEl.replaceChildren();
  loadingEl.hidden = true;
  bodyEl.hidden = true;
  errorEl.hidden = true;
}

function renderLoading() {
  clearChildren();
  loadingEl.hidden = false;
}

function renderError() {
  clearChildren();
  errorEl.hidden = false;
}

/**
 * Render the three fields in spec order: gloss (significado), example,
 * translation. Missing values degrade to a muted placeholder instead of an
 * empty box; an entry with neither gloss nor translation is an error.
 *
 * @param {{ gloss?: string, example?: string, translationEs?: string }} entry
 */
function renderEntry(entry) {
  const gloss = typeof entry?.gloss === "string" ? entry.gloss.trim() : "";
  const example = typeof entry?.example === "string" ? entry.example.trim() : "";
  const translation = typeof entry?.translationEs === "string" ? entry.translationEs.trim() : "";
  if (!gloss && !translation) {
    renderError();
    return;
  }
  clearChildren();
  bodyEl.append(
    lookupField("Significado", gloss || "Significado no disponible", gloss ? "" : "is-muted"),
    lookupField("Ejemplo", example || "—", example ? "is-example" : "is-muted"),
    lookupField("Español", translation || "—", translation ? "" : "is-muted"),
  );
  bodyEl.hidden = false;
}

/**
 * One labeled field of the card.
 * @param {string} label - field label
 * @param {string} value - field value (already trimmed)
 * @param {string} [valueClass] - extra class for muted/example styling
 */
function lookupField(label, value, valueClass) {
  return h("div", { class: "lookup-field" }, [
    h("span", { class: "lookup-label" }, label),
    h("p", { class: valueClass ? `lookup-value ${valueClass}` : "lookup-value" }, value),
  ]);
}

// --- positioning ------------------------------------------------------------

/**
 * Position the fixed popover above the anchor, falling back to below when it
 * does not fit, centered and clamped to the viewport (spec 112). Fixed
 * positioning never scrolls the page; the scroll listener closes the card
 * when the book moves under it.
 *
 * @param {{ left: number, top: number, width: number, height: number, bottom?: number }} rect
 */
function positionPopover(rect) {
  if (!pop || !rect) return;
  const gap = 8;
  const width = pop.offsetWidth;
  const height = pop.offsetHeight;
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.min(Math.max(gap, left), Math.max(gap, window.innerWidth - width - gap));
  const anchorBottom = typeof rect.bottom === "number" ? rect.bottom : rect.top + rect.height;
  let top = rect.top - height - gap;
  if (top < gap) top = anchorBottom + gap;
  if (top + height > window.innerHeight - gap) {
    top = Math.max(gap, window.innerHeight - height - gap);
  }
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

// --- open path --------------------------------------------------------------

/**
 * Open the popover for `rawText` anchored at `rect`: resolve through the
 * cache/request, showing the loading skeleton only if the answer takes
 * > ~200 ms. Stale responses (closed or superseded) are dropped.
 *
 * @param {{ left: number, top: number, width: number, height: number, bottom?: number }} rect
 * @param {string} rawText - selected/hovered text
 */
function openLookup(rect, rawText) {
  ensureNode();
  anchorRect = rect;
  requestId++;
  const id = requestId;
  isOpen = true;
  currentText = normalizeLookupText(rawText);
  clearTimeout(leaveTimer);
  leaveTimer = null;
  clearTimeout(loadingTimer);
  loadingTimer = setTimeout(() => {
    if (id !== requestId || !isOpen) return;
    renderLoading();
    pop.hidden = false;
    positionPopover(anchorRect);
  }, LOADING_MS);
  startGateWatch();
  lookupRequest(rawText).then((payload) => {
    if (id !== requestId || !isOpen) return;
    clearTimeout(loadingTimer);
    loadingTimer = null;
    if (payload) renderEntry(payload.entry);
    else renderError();
    pop.hidden = false;
    positionPopover(anchorRect);
  });
}

// --- DOM helpers ------------------------------------------------------------

/** @param {EventTarget|null} target @returns {Element|null} closest `.kw` */
function wordOf(target) {
  if (!target || typeof (/** @type {Element} */ (target).closest) !== "function") return null;
  return /** @type {Element} */ (target).closest(".kw");
}

/** Element view of a selection node (text nodes resolve to their parent). */
function nodeElement(node) {
  if (!node) return null;
  if (node.nodeType === 1) return /** @type {Element} */ (node);
  return node.parentElement;
}

/**
 * True when the selection sits inside the karaoke book or review words.
 * BOTH endpoints must be in scope (review fix #7): a drag that starts inside
 * the book and exits it must not open the card with foreign text.
 *
 * @param {Selection} sel
 */
function selectionInScope(sel) {
  const anchor = nodeElement(sel.anchorNode);
  const focus = nodeElement(sel.focusNode);
  return Boolean(anchor && anchor.closest(SCOPE_SEL) && focus && focus.closest(SCOPE_SEL));
}

/**
 * Looser variant: EITHER endpoint inside a scope container. Only used to keep
 * hover suppressed (`selectionActive`) while a drag is in flight — a strict
 * check there would re-arm hover the moment the pointer leaves the book.
 *
 * @param {Selection} sel
 */
function selectionTouchesScope(sel) {
  const anchor = nodeElement(sel.anchorNode);
  const focus = nodeElement(sel.focusNode);
  return Boolean((anchor && anchor.closest(SCOPE_SEL)) || (focus && focus.closest(SCOPE_SEL)));
}

/** Bounding rect of the selection (falls back to its anchor element). */
function selectionRect(sel) {
  try {
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0 || rect.top > 0)) return rect;
  } catch {
    // no range / not measurable — fall through to the anchor
  }
  const anchor = nodeElement(sel.anchorNode);
  return (anchor && anchor.getBoundingClientRect()) || {
    left: window.innerWidth / 2,
    top: window.innerHeight / 2,
    width: 0,
    height: 0,
    bottom: window.innerHeight / 2,
  };
}

// --- delegated listeners ----------------------------------------------------

/** Hover intent: arm (or re-arm) the ~300 ms timer over a `.kw`. */
function onPointerOver(event) {
  if (!hoverCapable || selectionActive) return;
  const kw = wordOf(event.target);
  if (!kw) return;
  const text = normalizeLookupText(kw.dataset.word ?? kw.textContent ?? "");
  if (!text || text.length > MAX_CHARS) return;
  if (isOpen && text === currentText) {
    // Re-entered the same word while the close grace was pending: cancel it,
    // otherwise the card vanishes under the cursor (review fix #6).
    clearTimeout(leaveTimer);
    leaveTimer = null;
    return;
  }
  if (!isAllowedFn()) return;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    if (selectionActive || !isAllowedFn() || !kw.isConnected) return;
    openLookup(kw.getBoundingClientRect(), text);
  }, HOVER_INTENT_MS);
}

/** Leaving a word: cancel the intent; keep/re-arm grace for the open card. */
function onPointerOut(event) {
  const kw = wordOf(event.target);
  if (!kw) return;
  const to = event.relatedTarget;
  // Moving inside the same word, or onto another `.kw` (its pointerover
  // takes over), never counts as leaving.
  if (to && (kw.contains(to) || wordOf(to))) return;
  clearTimeout(hoverTimer);
  hoverTimer = null;
  if (isOpen) scheduleClose();
}

/**
 * Press outside the card and outside the book surface closes it (spec 112:
 * click fuera). Presses inside `.karaoke-book`/`.review-words` never do — a
 * selection click there is about to pronounce the phrase (feature 113).
 */
function onPointerDown(event) {
  const target = /** @type {Element|null} */ (event.target);
  if (target && typeof target.closest === "function") {
    if (target.closest(POPOVER_SEL)) return; // presses inside the card never close it
    // Press inside the book keeps the card open (113: word/selection click →
    // audio + popover stays, including presses on line gaps).
    if (target.closest(WORD_PRESS_SEL)) return;
  }
  if (isOpen) closeLookupPopover();
  clearTimeout(hoverTimer);
  hoverTimer = null;
}

/**
 * Selection trigger: on `mouseup`, a non-collapsed selection inside the
 * karaoke book or review words opens the popover for the selected text —
 * one token behaves exactly like a hover, several resolve as a phrase.
 * The text is rebuilt from the `.kw` spans the Range intersects (see
 * `phraseFromRange`), never taken from `Range.toString()`.
 * A collapsed mouseup is left alone (click belongs to feature 113).
 */
function onMouseUp() {
  if (!isAllowedFn()) return;
  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
  if (!selectionInScope(sel)) return;
  // Reconstructed phrase; fall back to the native string only when no `.kw`
  // span intersects (plain-text containers without word spans).
  const reconstructed = phraseFromRange(sel.getRangeAt(0), document.querySelectorAll(WORD_SEL));
  const text = reconstructed || normalizeLookupText(sel.toString());
  if (!text || text.length > MAX_CHARS) return;
  if (isOpen && text === currentText) {
    clearTimeout(leaveTimer);
    leaveTimer = null;
    return;
  }
  selectionActive = true;
  openLookup(selectionRect(sel), text);
}

/** Track whether a karaoke selection still owns the popover (hover off). */
function onSelectionChange() {
  const sel = window.getSelection ? window.getSelection() : null;
  if (!sel || sel.isCollapsed || !selectionTouchesScope(sel)) selectionActive = false;
}

/** Escape closes the card (spec 112). */
function onKeyDown(event) {
  if (event.key === "Escape" && isOpen) closeLookupPopover();
}
