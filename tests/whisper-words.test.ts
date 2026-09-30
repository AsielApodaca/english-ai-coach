import { test } from "node:test";
import assert from "node:assert/strict";
import { parseWhisperWordsJSON } from "../src/lib/whisper.ts";

test("parseWhisperWordsJSON: segments with seconds floats → rounded ms", () => {
  const raw = JSON.stringify({
    text: "hello world",
    segments: [
      { text: "hello", start: 0.0, end: 0.5 },
      { text: "world", start: 0.55, end: 1.1 },
    ],
  });
  assert.deepEqual(parseWhisperWordsJSON(raw), [
    { word: "hello", startMs: 0, endMs: 500 },
    { word: "world", startMs: 550, endMs: 1100 },
  ]);
});

// Regression guard: segmentToWord used to apply secondsToMs (×1000) to
// `offsets`; the `timestamps` array is preferred (unambiguous) and offsets are
// treated as milliseconds. These encode the correct expectations.
test("parseWhisperWordsJSON: transcription + timestamps/offsets shape → documented ms", () => {
    const raw = JSON.stringify({
      transcription: "hello world",
      timestamps: [
        { timestamps: { from: "0.00", to: "1.00" }, offsets: { from: 0, to: 100 }, text: "hello" },
        { timestamps: { from: "1.00", to: "2.50" }, offsets: { from: 100, to: 250 }, text: "world" },
      ],
    });
    assert.deepEqual(parseWhisperWordsJSON(raw), [
      { word: "hello", startMs: 0, endMs: 1000 },
      { word: "world", startMs: 1000, endMs: 2500 },
    ]);
  },
);

// Ground truth captured from a real `whisper-cli -f x.wav -oj -ml 1` run:
// `offsets` in milliseconds, `timestamps` as "HH:MM:SS,mmm". `timestamps` is
// the resolution source and must render these ms exactly.
test("parseWhisperWordsJSON: real whisper.cpp -oj -ml 1 output → offsets as ms", () => {
    const raw = JSON.stringify({
      transcription: [
        { timestamps: { from: "00:00:00,000", to: "00:00:01,120" }, offsets: { from: 0, to: 1120 }, text: " I" },
        { timestamps: { from: "00:00:01,120", to: "00:00:01,920" }, offsets: { from: 1120, to: 1920 }, text: " handled" },
      ],
    });
    assert.deepEqual(parseWhisperWordsJSON(raw), [
      { word: "I", startMs: 0, endMs: 1120 },
      { word: "handled", startMs: 1120, endMs: 1920 },
    ]);
  },
);

// Ground truth captured from a real `whisper-cli -oj -ml 1 -sow` run (the flag
// passed by transcribeWords since the sub-word split regression: " autom"+"ating"
// arrived as two words and the coach treated "autom" as a word to discard).
// `-sow` emits whole words, punctuation attached to the preceding word.
test("parseWhisperWordsJSON: real -oj -ml 1 -sow output → whole words, no sub-word splits", () => {
    const raw = JSON.stringify({
      transcription: [
        { timestamps: { from: "00:00:00,000", to: "00:00:01,390" }, offsets: { from: 0, to: 1390 }, text: " My" },
        { timestamps: { from: "00:00:01,390", to: "00:00:02,960" }, offsets: { from: 1390, to: 2960 }, text: " main" },
        { timestamps: { from: "00:00:02,960", to: "00:00:02,960" }, offsets: { from: 2960, to: 2960 }, text: " task" },
        { timestamps: { from: "00:00:02,960", to: "00:00:02,960" }, offsets: { from: 2960, to: 2960 }, text: " is" },
        { timestamps: { from: "00:00:02,960", to: "00:00:02,960" }, offsets: { from: 2960, to: 2960 }, text: " automating" },
        { timestamps: { from: "00:00:02,960", to: "00:00:02,960" }, offsets: { from: 2960, to: 2960 }, text: " the" },
        { timestamps: { from: "00:00:02,960", to: "00:00:02,960" }, offsets: { from: 2960, to: 2960 }, text: " end-to-end" },
        { timestamps: { from: "00:00:02,960", to: "00:00:30,000" }, offsets: { from: 2960, to: 30000 }, text: " tests." },
      ],
    });
    const words = parseWhisperWordsJSON(raw);
    assert.deepEqual(
      words.map((w) => w.word),
      ["My", "main", "task", "is", "automating", "the", "end-to-end", "tests."],
    );
    assert.deepEqual(words[0], { word: "My", startMs: 0, endMs: 1390 });
    assert.deepEqual(words[7], { word: "tests.", startMs: 2960, endMs: 30000 });
  },
);

test("parseWhisperWordsJSON: timestamps strings (HH:MM:SS,mmm) without offsets → ms", () => {
  const raw = JSON.stringify({
    transcription: [{ timestamps: { from: "00:00:00,000", to: "00:00:01,120" }, text: "I" }],
  });
  assert.deepEqual(parseWhisperWordsJSON(raw), [{ word: "I", startMs: 0, endMs: 1120 }]);
});

test("parseWhisperWordsJSON: empty/whitespace tokens are filtered out", () => {
  const raw = JSON.stringify({
    text: "hi",
    segments: [
      { text: "", start: 0, end: 0.1 },
      { text: "   ", start: 0.1, end: 0.2 },
      { text: "hi", start: 0.1, end: 0.4 },
    ],
  });
  assert.deepEqual(parseWhisperWordsJSON(raw), [{ word: "hi", startMs: 100, endMs: 400 }]);
});

test("parseWhisperWordsJSON: no usable word tokens → full text kept as one fallback token", () => {
  // Whitespace-only entries plus a top-level full text.
  assert.deepEqual(
    parseWhisperWordsJSON(JSON.stringify({ text: "hi there", segments: [{ text: "   ", start: 0, end: 0.1 }] })),
    [{ word: "hi there", startMs: 0, endMs: 0 }],
  );
  // Array entries without any text field, full text available.
  assert.deepEqual(
    parseWhisperWordsJSON(JSON.stringify({ text: "hello world", segments: [{ foo: 1 }] })),
    [{ word: "hello world", startMs: 0, endMs: 0 }],
  );
  // No word array at all, transcription string only.
  assert.deepEqual(parseWhisperWordsJSON(JSON.stringify({ transcription: "hello world" })), [
    { word: "hello world", startMs: 0, endMs: 0 },
  ]);
});

test("parseWhisperWordsJSON: invalid or non-object JSON yields no words", () => {
  assert.deepEqual(parseWhisperWordsJSON("not json"), []);
  assert.deepEqual(parseWhisperWordsJSON("42"), []);
  assert.deepEqual(parseWhisperWordsJSON("{}"), []);
});
