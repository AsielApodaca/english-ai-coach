import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Verbatim invariant (feature 110): every string handed to the TTS layer for
// a fragment read must be EXACTLY `fragment.text` — no prefix, no suffix —
// in all three branches (first read, advance after pass, retry after fail).
// The source of the imperative view is read as text: it is the only place the
// three branches live, and it cannot be imported (browser module + DOM).
// ---------------------------------------------------------------------------

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const viewSrc = readFileSync(join(repoRoot, "public", "ui", "practice-view.js"), "utf8");

/** Every file under `public/` (browser bundle — no spoken literal may live here). */
function publicFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? publicFiles(path) : [path];
  });
}

test("fragment reads pass `fragment.text` directly to the TTS layer", () => {
  // The loop read (serves the first read, the post-pass advance AND the
  // post-fail retry — all three branches share this single call site).
  assert.match(viewSrc, /speakWithKaraoke\(question\.fragments\[fi\]\.text,/);
  // Never concatenated with a prefix or suffix…
  assert.doesNotMatch(viewSrc, /question\.fragments\[fi\]\.text\s*\+/);
  assert.doesNotMatch(viewSrc, /\+\s*question\.fragments\[fi\]\.text/);
  // …and exactly two reads exist: the model answer + the fragment (no extra
  // call site that could smuggle a decorated string in).
  assert.equal(viewSrc.match(/await speakWithKaraoke\(/g)?.length, 2);
});

test("no congratulation / instruction literal exists anywhere in public/", () => {
  // Spec 110: the only allowed occurrences live in `src/lib/practice/karaoke.ts` (the
  // definition of the now-unspoken pass line) — never in the browser bundle.
  const forbidden = [/Great\s+job/i, /repeat[^.\n]*after me/i, /Let.s continue/i];
  for (const file of publicFiles(join(repoRoot, "public"))) {
    const source = readFileSync(file, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${file} must not contain ${pattern}`);
    }
  }
});

test("the duplicated no-speech timeout literal is feedback, never a read prefix", () => {
  const literal = "I didn't hear you. Let's try that again.";
  // Duplicated by hand in `timedOutOutcome()` (mirrors buildNoSpeechText)…
  assert.equal(viewSrc.split(literal).length - 1, 1);
  assert.match(viewSrc, /coachLine: "I didn't hear you\. Let's try that again\."/);
  // …spoken as the FAIL feedback before the retry, and never passed straight
  // into a TTS read (the retry re-read stays verbatim fragment text).
  assert.doesNotMatch(viewSrc, /speak(?:WithKaraoke)?\(\s*[^)]*I didn't hear you/);
});
