/**
 * Karaoke highlight scheduling (feature 114).
 *
 * `buildWordStarts` computes the onset time (ms) of every highlighted word
 * so the highlight PAUSES during the clause silences the server inserted —
 * a plain linear spread keeps advancing while the audio sits in a
 * 220–650 ms pause and lights words ahead of the coach (the drift the
 * review called out).
 *
 * Pure and DOM-free on purpose (same pattern as `word-click.js`): it lives
 * here so `tests/karaoke-schedule.test.ts` can exercise it in Node, while
 * `practice-view.js` owns the rAF loop that applies it. It must only be used
 * when the served audio ACTUALLY contains those silences — the Piper path;
 * edge-tts joins the segments without them, so the practice view keys the
 * schedule off the response's `X-TTS-Pauses: measured|none` header (review
 * major #1).
 */

/**
 * Per-word highlight onsets (ms) that pause during the clause silences.
 *
 * The schedule is only trusted when the segment word count matches the span
 * count (the book tokenizes contractions the same way, but any mismatch —
 * e.g. reading a fragment with the full answer's spans — falls back to the
 * linear animation, which is always safe).
 *
 * Each segment gets a share of the speech time proportional to its word
 * count; its words spread evenly inside that share; its pause follows. With
 * all-zero pauses the result collapses exactly onto the linear spread.
 *
 * @param {number} durationMs - total audio duration (incl. pauses)
 * @param {string[]} segments - clauses the server synthesized
 * @param {number[]} pausesMs - silence after each segment (same length)
 * @param {number} spanCount - number of highlighted word spans
 * @returns {number[]|null} onset in ms per span, or null for linear spread
 */
export function buildWordStarts(durationMs, segments, pausesMs, spanCount) {
  if (!(durationMs > 0) || !segments.length || pausesMs.length !== segments.length) return null;
  const counts = segments.map((s) => s.split(/\s+/).filter(Boolean).length);
  const words = counts.reduce((a, b) => a + b, 0);
  if (words !== spanCount || words === 0) return null;
  const totalPause = pausesMs.reduce((a, b) => a + b, 0);
  const speechMs = durationMs - totalPause;
  if (speechMs <= 0) return null;
  const starts = [];
  let cursor = 0;
  counts.forEach((n, i) => {
    const segMs = (speechMs * n) / words;
    for (let w = 0; w < n; w++) starts.push(cursor + (segMs * w) / n);
    cursor += segMs + pausesMs[i];
  });
  return starts;
}
