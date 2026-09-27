/**
 * Pure karaoke coloring helpers (feature 105 / CU2).
 *
 * DOM-free functions shared by the practice view and its unit tests. They own
 * the index mapping that caused the "painted words of another fragment" bug:
 * an aligned `words[]` is LOCAL to the target it was scored against (see
 * `src/lib/align.ts`), while the word spans of a karaoke line are LOCAL to
 * that line — the two only pair up one-to-one inside a single line.
 */

/**
 * Split a line of text into the display words the karaoke book renders.
 * Same rules as the target tokenizer of `src/lib/align.ts`, so a line always
 * gets exactly one span per target word.
 *
 * @param {unknown} text - raw line text (null/undefined tolerated)
 * @returns {string[]} the non-empty whitespace-separated words
 */
export function tokenizeWords(text) {
  return String(text ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Statuses to paint on a line of `spanCount` word spans.
 *
 * Only the first `spanCount` entries of `words` are consumed: anything beyond
 * them (the filler *extras* the aligner appends, or the words of a longer
 * line) is discarded, so a short fragment can never paint spans of another
 * line. Entries without a recognized traffic-light status map to `null`
 * (the span stays white).
 *
 * @param {Array<{ status?: string }>|null|undefined} words - aligned words of the attempt
 * @param {number} spanCount - exact number of spans of the line being painted
 * @returns {Array<"green" | "amber" | "red" | null>} one entry per span, in order
 */
export function lineColorStatuses(words, spanCount) {
  if (!Number.isInteger(spanCount) || spanCount < 0) return [];
  const source = Array.isArray(words) ? words : [];
  const statuses = [];
  for (let i = 0; i < spanCount; i++) {
    const status = source[i]?.status;
    statuses.push(status === "green" || status === "amber" || status === "red" ? status : null);
  }
  return statuses;
}

/**
 * Number of display words of each fragment of a question (offsets + tests).
 *
 * @param {Array<{ text?: string }>|null|undefined} fragments - question fragments
 * @returns {number[]} one word count per fragment, in order
 */
export function fragmentWordCounts(fragments) {
  return (Array.isArray(fragments) ? fragments : []).map((f) => tokenizeWords(f?.text).length);
}
