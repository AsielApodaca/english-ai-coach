/**
 * Clause splitter for TTS prosody (feature 114).
 *
 * Splits a coach utterance into clauses so `/api/tts` can synthesize each one
 * separately and glue them back into ONE audio file with measured silence
 * between them — the micro-pauses a human speaker makes between ideas and the
 * current engines (Piper / edge-tts) never make on their own.
 *
 * The implementation lives here (browser module) because the practice view
 * cannot import `src/lib/*.ts` (no build step) AND the server needs the very
 * same splitter; `src/lib/audio/prosody.ts` re-exports this module so there is a
 * single source of truth for both sides (and for `tests/prosody.test.ts`).
 *
 * Pure and deterministic: no I/O, no globals, same input → same output.
 */

/** Pause after a clause closed by `, ; : —` (ms; spec range 180–250). */
export const SHORT_PAUSE_MS = 220;

/** Pause after a clause closed by `. ? !` (ms; spec range 350–450). */
export const MEDIUM_PAUSE_MS = 400;

/** End-of-utterance handover pause (ms; spec range 600–700). */
export const LONG_PAUSE_MS = 650;

/** Max segments per utterance so a long line cannot collapse the endpoint. */
export const MAX_SEGMENTS = 12;

/** Texts up to this word count are never split. */
export const SHORT_TEXT_MAX_WORDS = 4;

/**
 * Abbreviations that NEVER end a clause (`Mr.` always introduces a name).
 * Lower-case, without the dot.
 */
const ALWAYS_ABBREV = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "cf", "al", "no",
]);

/**
 * Abbreviations that only stay mid-clause when the next word starts lower
 * case (`etc. papers`) but DO end a clause before a capital (`etc. Then…`).
 * Lower-case, without the dot.
 */
const CONDITIONAL_ABBREV = new Set([
  "etc", "inc", "ltd", "co", "dept", "est", "approx", "min", "max", "vol",
  "fig", "ref", "am", "pm", "jan", "feb", "mar", "apr", "jun", "jul", "aug",
  "sep", "sept", "oct", "nov", "dec", "sun", "mon", "tue", "wed", "thu",
  "fri", "sat",
]);

/** Opening brackets whose content must never be split (spec: respeta corchetes). */
function isOpenBracket(ch) {
  return ch === "(" || ch === "[" || ch === "{";
}

/** Closing counterparts (depth tracking only; never consume into a segment). */
function isCloseBracket(ch) {
  return ch === ")" || ch === "]" || ch === "}";
}

/** Punctuation that closes a quote/parenthesis right after `.?!` (`."` etc.). */
function isClosingQuote(ch) {
  return ch === '"' || ch === "'" || ch === "\u201d" || ch === "\u2019";
}

function isDigit(ch) {
  return ch >= "0" && ch <= "9";
}

function isLetter(ch) {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function isAlnum(ch) {
  return isLetter(ch) || isDigit(ch);
}

/** The letters immediately before `index` (no trailing dot). */
function tokenBefore(src, index) {
  let start = index;
  while (start > 0 && isLetter(src[start - 1])) start--;
  return src.slice(start, index);
}

/** First character after `index`, skipping spaces; "" at end of text. */
function nextVisibleChar(src, index) {
  let i = index;
  while (i < src.length && /\s/.test(src[i])) i++;
  return i < src.length ? src[i] : "";
}

/** First character before `index`, skipping spaces; "" at start of text. */
function prevVisibleChar(src, index) {
  let i = index;
  while (i > 0 && /\s/.test(src[i - 1])) i--;
  return i > 0 ? src[i - 1] : "";
}

/**
 * True when the `.` at `index` must not end a clause.
 *
 * Rules: mid-word dots (`e.g.`, `config.json`, `U.S.`), decimals (`3.5`),
 * titles (`Mr. Smith`), single-letter initials (`J. R. R. Tolkien`) and
 * lower-case-conditional abbreviations (`etc. papers`). The pronoun `I.` is
 * deliberately NOT protected — it is almost always a sentence end.
 */
function isProtectedDot(src, index) {
  const prev = src[index - 1] ?? "";
  const next = src[index + 1] ?? "";
  if (isAlnum(prev) && isAlnum(next)) return true; // decimal / mid-word dot
  const token = tokenBefore(src, index).toLowerCase();
  if (!token) return false;
  if (token.length === 1) return token !== "i"; // initials, e.g., i.e.
  if (ALWAYS_ABBREV.has(token)) return true;
  if (CONDITIONAL_ABBREV.has(token)) {
    const after = nextVisibleChar(src, index + 1);
    return after !== "" && after === after.toLowerCase() && isLetter(after);
  }
  return false;
}

/**
 * Match a clause boundary starting at `index`.
 *
 * @param {string} src - full text
 * @param {number} index - position of a candidate punctuation mark
 * @param {number} depth - current bracket depth (0 outside brackets)
 * @returns {{ pause: number, end: number } | null} the pause to insert after
 *   the clause and the index right after the consumed punctuation run, or
 *   null when this is not a boundary (abbreviation, number, inside brackets).
 */
function matchBoundary(src, index, depth) {
  if (depth > 0) return null;
  const ch = src[index];
  const prev = src[index - 1] ?? "";
  const next = src[index + 1] ?? "";

  // --- short pause: comma, semicolon, colon, dashes ---
  if (ch === "," || ch === ";" || ch === ":") {
    if (isDigit(prev) && isDigit(next)) return null; // 1,234 · 3:30
    let end = index + 1;
    while (end < src.length && ",;:".includes(src[end])) end++;
    return { pause: SHORT_PAUSE_MS, end };
  }
  if (ch === "\u2014" || ch === "\u2013" || (ch === "-" && /\s/.test(prev) && /\s/.test(next))) {
    // A dash between digits is a number range, not a clause break
    // (`10 - 20`, `10 — 20`): look past the spaces, same spirit as the
    // digit guard on `,;:`.
    if (isDigit(prevVisibleChar(src, index)) && isDigit(nextVisibleChar(src, index + 1))) {
      return null;
    }
    return { pause: SHORT_PAUSE_MS, end: index + 1 };
  }

  // --- medium pause: . ? ! (plus ellipsis runs and ?! sequences) ---
  if (ch === "." || ch === "?" || ch === "!") {
    if (ch === "." && isProtectedDot(src, index)) return null;
    let end = index;
    while (end < src.length && ".?!".includes(src[end])) end++; // "..." · "?!"
    while (end < src.length && isClosingQuote(src[end])) end++; // `."` → stay together
    return { pause: MEDIUM_PAUSE_MS, end };
  }
  return null;
}

/**
 * Split text into TTS clauses with the silence that follows each one.
 *
 * Contract:
 *   - `segments.length >= 1` for any non-empty input (never empty segments).
 *   - `pausesMs.length === segments.length`; `pausesMs[i]` is the silence to
 *     append AFTER `segments[i]`. The last entry is always the long handover
 *     pause; the others follow the punctuation that closed their clause.
 *   - Texts of ≤ {@link SHORT_TEXT_MAX_WORDS} words are returned as one
 *     segment; results never exceed {@link MAX_SEGMENTS} segments.
 *
 * @param {string} text - the coach utterance
 * @returns {{ segments: string[], pausesMs: number[] }}
 */
export function splitForTts(text) {
  const src = String(text ?? "").trim();
  if (!src) return { segments: [], pausesMs: [] };
  if (src.split(/\s+/).length <= SHORT_TEXT_MAX_WORDS) {
    return { segments: [src], pausesMs: [LONG_PAUSE_MS] };
  }

  /** @type {{ text: string, pause: number }[]} */
  const pieces = [];
  let start = 0;
  let depth = 0;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    if (isOpenBracket(ch)) {
      depth++;
      i++;
      continue;
    }
    if (isCloseBracket(ch)) {
      depth = Math.max(0, depth - 1);
      i++;
      continue;
    }
    const boundary = matchBoundary(src, i, depth);
    if (!boundary) {
      i++;
      continue;
    }
    // A boundary with no speech before it (`"Hello,, world"`) just drops the
    // stray punctuation instead of producing a punctuation-only segment.
    if (src.slice(start, i).trim() === "") {
      start = boundary.end;
      i = boundary.end;
      continue;
    }
    pieces.push({ text: src.slice(start, boundary.end), pause: boundary.pause });
    start = boundary.end;
    i = boundary.end;
    // Stop splitting once the cap is reached: the rest joins the last piece.
    if (pieces.length >= MAX_SEGMENTS - 1) break;
  }
  if (start < src.length) {
    pieces.push({ text: src.slice(start), pause: LONG_PAUSE_MS });
  }

  const cleaned = pieces
    .map((p) => ({ text: p.text.trim(), pause: p.pause }))
    .filter((p) => p.text.length > 0);
  // Punctuation-only input (`", , , ,"`) leaves nothing to place: fall back
  // to the whole source as ONE segment so the documented contract holds
  // (`>= 1` segment for non-empty input — the server answers 400 otherwise).
  if (cleaned.length === 0) return { segments: [src], pausesMs: [LONG_PAUSE_MS] };

  // The final segment always gets the long handover beat (the learner is
  // about to speak); every other keeps the pause of its closing punctuation.
  const segments = cleaned.map((p) => p.text);
  const pausesMs = cleaned.map((p, idx) =>
    idx === cleaned.length - 1 ? LONG_PAUSE_MS : p.pause,
  );
  return { segments, pausesMs };
}
